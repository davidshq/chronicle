# Architecture

This document describes the architecture of **Chronicle**, an external, lossless
recorder for Claude Code sessions. Chronicle is a single Rust binary with
git-style subcommands, split into two roles: an always-on **capture daemon** and
a thin **in-session plugin** (search + a health watchdog).

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Claude Code                                   │
│  writes transcripts to ~/.claude/projects/<project>/<session>.jsonl        │
└───────────────────────────────┬──────────────────────────────────────────┘
                                 │  (append-only JSONL)
                                 ▼
        ┌────────────────────────────────────────────────┐
        │        chronicle daemon (external process)      │
        │                                                 │
        │   trigger: filesystem-watch (live) or poll      │
        │                     │                           │
        │                     ▼                           │
        │            capture::Engine::sync_file           │
        │             (read since last offset,            │
        │              process to last newline)           │
        │            │            │            │           │
        │            ▼            ▼            ▼           │
        │         raw/         markdown/     index.db      │
        │      (verbatim)      (derived)    (derived FTS)  │
        └────────────────────────────────────────────────┘
                                 │
                                 ▼
                          ~/.chronicle/  (the store)

        ┌────────────────────────────────────────────────┐
        │   chronicle plugin (in-session, thin client)    │
        │                                                 │
        │   SessionStart hook ──► `chronicle watchdog`    │
        │       (reads heartbeat.json, warns if stale)    │
        │   /chronicle:search ──► `chronicle search`      │
        │   /chronicle:status ──► `chronicle status`      │
        │   /chronicle:today  ──► `chronicle status --today`
        └────────────────────────────────────────────────┘
```

The two roles never share process state — they communicate only through the
store on disk (`heartbeat.json` for liveness, `index.db` for queries). Capture
does **not** depend on hooks firing, which is the whole point: hooks fail
silently in long sessions, on `/exit`, and during `/compact`.

## Why an external daemon?

The predecessor was a hook-based plugin that logged from inside Claude Code.
That approach loses data whenever a hook doesn't fire, and it can't outlive
Claude Code deleting its own transcripts. Chronicle inverts this: an independent
process tails the transcript files, so:

- Capture is **hook-independent** — it keeps working through `/compact`,
  `/exit`, and long sessions where hooks go quiet.
- The archive **survives retention deletion** — once bytes are copied into `raw/`,
  they persist even after Claude Code removes the source.
- The in-session plugin becomes a **read-only client** plus a watchdog, so a
  monitoring failure can never affect capture.

## Data Flow

### 1. Trigger (`src/capture/watch.rs`, `src/capture/poll.rs`)

- **Live** (default): a `notify` recursive watcher blocks on the OS notification
  channel and calls the engine only when a transcript file changes. Lightest at
  idle.
- **Poll** (fallback): a fixed-interval loop calls `scan_all` where filesystem-
  watch APIs are unavailable/restricted. Because transcripts are append-only, a
  seconds-scale poll loses nothing.

Both call into one shared `Engine`; the trigger only decides *when*.

### 2. Capture engine (`src/capture/engine.rs`)

`sync_file` is the hot path for a single transcript file:

1. `stat` the file; if it shrank below our stored offset, reset to 0 (rotation).
2. Read the bytes appended since the last **persisted byte offset**.
3. Find the last `\n`; process only up to it. A trailing partial line is left
   unconsumed (buffered) — never committed until it's complete.
4. **Raw layer:** append the complete bytes verbatim to `raw/<rel>.jsonl`.
5. **Derived layers:** parse each complete line and feed the index + markdown.
6. Advance the offset to the newline boundary and persist it atomically.

Because the offset only ever lands on a newline boundary and is persisted with a
temp-file + rename, a daemon restart resumes exactly where it left off — no
duplicated bytes, no skipped lines. (`tests/capture.rs` covers verbatim copy,
restart resume, and partial-line buffering.)

### 3. Offsets (`src/capture/offset.rs`)

A `HashMap<file path, u64>` persisted to `state/offsets.json`. The value is the
number of fully-consumed bytes for that file. Written atomically only when dirty.

### 4. Parsing (`src/jsonl.rs`)

Deliberately permissive. It extracts `session_id`, `cwd`, `timestamp`, `uuid`,
and a list of `Entry` values (`Text`, `ToolUse`, `ToolResult`) from a line.
Unknown shapes yield **no entries rather than an error**, so transcript-format
drift degrades the derived layers gracefully and never risks the raw copy. Only
the derived layers parse; the raw layer copies bytes and never depends on this.

## Storage Layers

Each layer is independently opt-in via `config.layers`. Raw is the ground truth;
the others are derived and can be deleted and rebuilt from raw at any time
(`chronicle rebuild`, proven by `tests/layers.rs`).

### Raw (`src/layers/raw.rs`)

Verbatim, byte-for-byte, append-only mirror of the source directory structure.
Never parses, filters, or truncates. Immune to format drift; survives source
deletion.

### Markdown (`src/layers/markdown.rs`)

Human-readable rendering, one file per session under `markdown/<project>/<YYYY-MM-DD>/`.
MAY truncate large tool bodies (bounded by `max_tool_output_length`) because the
untruncated original always lives in raw. Tool-input formatting is specialized
per tool (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch; others fall
back to a pretty-printed JSON block).

### SQLite + FTS (`src/db.rs`)

The queryable index. WAL mode, `busy_timeout`, `synchronous=NORMAL`.

```sql
sessions
├── id            TEXT PRIMARY KEY
├── project_path  TEXT
├── started_at    TEXT
├── ended_at      TEXT
├── status        TEXT DEFAULT 'active'
├── message_count INTEGER
├── markdown_path TEXT
└── raw_path      TEXT

messages
├── id          INTEGER PRIMARY KEY
├── session_id  TEXT
├── uuid        TEXT
├── timestamp   TEXT
├── role        TEXT            -- user | assistant | system | tool
├── content     TEXT
├── tool_name   TEXT
├── tool_input  TEXT
└── tool_output TEXT
    UNIQUE(session_id, uuid)

tool_calls
├── id            INTEGER PRIMARY KEY
├── session_id    TEXT
├── message_id    INTEGER
├── timestamp     TEXT
├── tool_name     TEXT
└── input_summary TEXT

messages_fts  -- FTS5 virtual table over (content, tool_name, tool_input,
              -- tool_output), external-content mirror of `messages`, kept in
              -- sync by AFTER INSERT / AFTER DELETE triggers.
```

`insert_message` uses `INSERT OR IGNORE` keyed on `(session_id, uuid)` so
re-indexing does not duplicate rows that carry a uuid.

## Store Layout (`~/.chronicle` by default)

```
~/.chronicle/
  bin/chronicle                   the installed binary (daemon + plugin both use it)
  config.json                     user config
  heartbeat.json                  { pid, started_at, last_sync }  ← watchdog reads this
  state/offsets.json              per-file byte offsets (restart-safe capture)
  raw/<project>/<session>.jsonl   verbatim archive (ground truth)
  markdown/<project>/<YYYY-MM-DD>/*.md   rendered mirror
  index.db                        SQLite + FTS5
```

The binary lives at a fixed, well-known path so both the daemon service and the
plugin reference it by absolute path — a single source of truth, so the plugin
can never drift to a different version than the daemon writing the store.
Override the location with the `CHRONICLE_HOME` environment variable.

## The Watchdog (`src/commands/watchdog.rs`)

Invoked by the SessionStart hook. Reads `heartbeat.json` and reports one of:

- **Healthy** — process alive and `last_sync` within `staleness_secs`.
- **Stale** — process alive but `last_sync` older than `staleness_secs`.
- **Down** — no heartbeat, or the recorded pid is not alive.

It is **non-destructive and always exits 0**. Capture runs in the separate
daemon, so the worst a watchdog failure can do is miss a warning.

## Subcommands (`src/commands/`)

| Command | Role | Notes |
|---------|------|-------|
| `daemon` | capture | live/poll/`--once`; honors `enabled=false` by idling |
| `search` | plugin | FTS5 query over `index.db` |
| `status` | plugin | watchdog health + recent (or `--today`) sessions |
| `watchdog` | plugin | liveness/staleness check for the SessionStart hook |
| `rebuild` | maintenance | drop derived layers, replay from `raw/` |
| `migrate` | one-time | import an old `~/.claude-logs` store |

## Design Decisions

### Raw is the source of truth

Every other layer is derived and disposable. `rebuild` replays `raw/` back
through the derived layers with an isolated offsets file, and a test asserts the
reconstructed index is searchable — so "raw is ground truth" is verified, not
just claimed.

### Restart-safe by construction

Newline-boundary offsets + atomic persistence mean the capture position is always
consistent with the bytes actually written. Partial lines are buffered rather
than committed, so a crash mid-write never corrupts a layer.

### Fail-safe monitoring

The watchdog and any plugin command must never impede a session. The watchdog
always exits 0; capture is entirely decoupled from it.

### Minimal dependencies

`notify` (filesystem events), `rusqlite` with bundled SQLite (no system dep),
`serde`/`serde_json`, `clap`, `chrono`, `anyhow`, `dirs`. Release profile is
size-optimized (`opt-level = "z"`, LTO, stripped).

### Timezone handling

Timestamps are stored verbatim from the transcript (UTC). `status --today` and
markdown date-folder bucketing currently derive dates from those timestamps; see
`docs/CODE-REVIEW.md` for the known local-vs-UTC nuance around midnight.

## Migration from the old plugin

`chronicle migrate` preserves an existing `~/.claude-logs` store from the old
hook-based `claude-remember` plugin: markdown sessions are copied under
`markdown/imported/` and the legacy SQLite db is kept as `legacy-sessions.db`,
rather than lost. Fresh capture then comes from the daemon reading
`~/.claude/projects`.
