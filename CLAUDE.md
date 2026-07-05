# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chronicle is an **external, lossless recorder for Claude Code sessions**, written
in Rust as a single binary with git-style subcommands. It has two roles:

1. **Capture daemon** (`chronicle daemon`) — an always-on background service that
   watches Claude Code's transcript JSONL files and records them. It runs
   *outside* Claude Code, so capture does not depend on hooks firing (which fail
   silently in long sessions, on `/exit`, and during `/compact`), and the record
   survives Claude Code deleting its own old transcripts.
2. **In-session plugin** — a thin client (`search` / `status` / `today` slash
   commands plus a SessionStart health **watchdog**) that shells out to the same
   installed binary. It does *not* capture; it queries and monitors.

The binary is installed to a fixed, well-known path (`~/.chronicle/bin/chronicle`)
that both the daemon service and the plugin reference by absolute path — a single
source of truth so the plugin can never drift to a different version than the
daemon writing the store.

## Commands

```bash
# Build / test / lint (CI runs all three; clippy is -D warnings)
cargo build
cargo test
cargo clippy -- -D warnings

# Install the binary + register the daemon service (systemd/launchd) + migrate
./scripts/install.sh

# Run the binary directly during development
cargo run -- daemon --once          # capture everything once and exit
cargo run -- daemon                 # live filesystem-watch capture (default)
cargo run -- daemon --poll          # periodic-poll capture fallback
cargo run -- status                 # capture health + recent sessions
cargo run -- status --today         # today's (local) sessions
cargo run -- search "query"         # FTS5 full-text search
cargo run -- watchdog               # liveness/staleness check (hook-invoked)
cargo run -- rebuild                # rebuild derived layers from the raw archive
cargo run -- migrate                # import an old ~/.claude-logs store

# Point any subcommand at an alternate store
cargo run -- status --store /tmp/chronicle-test
```

## Repository Structure

```
chronicle/
├── .claude-plugin/
│   ├── plugin.json           # Plugin manifest
│   └── marketplace.json      # Marketplace listing
├── hooks/
│   └── hooks.json            # SessionStart → watchdog (resolves the fixed-path binary)
├── commands/
│   ├── search.md             # /chronicle:search
│   ├── status.md             # /chronicle:status
│   └── today.md              # /chronicle:today
├── scripts/
│   └── install.sh            # build → install to ~/.chronicle/bin → service → migrate
├── src/
│   ├── main.rs               # CLI entry: clap subcommand dispatch
│   ├── lib.rs                # library crate root (tests exercise this directly)
│   ├── config.rs             # Config model + load/save (<store>/config.json)
│   ├── db.rs                 # SQLite index + FTS5 (derived layer)
│   ├── jsonl.rs              # lenient transcript-line parser
│   ├── store.rs              # store layout + heartbeat + process-liveness
│   ├── capture/
│   │   ├── engine.rs         # the shared capture engine (sync_file hot path)
│   │   ├── offset.rs         # restart-safe per-file byte offsets
│   │   ├── watch.rs          # live filesystem-watch trigger (default)
│   │   └── poll.rs           # periodic-poll trigger (fallback)
│   ├── layers/
│   │   ├── raw.rs            # verbatim JSONL archive (ground truth)
│   │   └── markdown.rs       # human-readable mirror (derived)
│   └── commands/
│       ├── daemon.rs         # the capture service
│       ├── search.rs         # FTS query
│       ├── status.rs         # health + recent/today sessions
│       ├── watchdog.rs       # liveness/staleness evaluation
│       ├── migrate.rs        # import old ~/.claude-logs store
│       └── rebuild.rs        # replay raw → derived layers
├── tests/                    # integration tests (capture, layers, watchdog)
├── openspec/                 # design rationale for the rewrite
└── docs/                     # ARCHITECTURE, DEVELOPMENT, TODO, CODE-REVIEW
```

## Architecture

### Data flow

```
Claude Code transcripts (~/.claude/projects/**/*.jsonl)
   │  (filesystem watch or poll)
   ▼
capture::Engine::sync_file  ──►  raw archive (verbatim, byte-for-byte)
   │                          └►  derived layers:
   │                                • markdown mirror
   │                                • SQLite + FTS5 index
   ▼
~/.chronicle/  (store: raw/, markdown/, index.db, state/, heartbeat.json)
```

### The capture engine (`src/capture/engine.rs`)

`sync_file` is the hot path: read bytes appended since the last persisted offset,
process only through the **last newline** (trailing partial lines are buffered,
never persisted), append the complete bytes verbatim to the raw archive, then
feed each parsed line to the derived layers. The offset only ever advances to a
newline boundary and is persisted atomically, so restarts and partial writes
resume exactly where capture left off — no duplication, no gaps.

### Storage layers (each independently opt-in via `config.layers`)

- **Raw** (`layers/raw.rs`) — the lossless ground truth. Copies complete
  transcript lines byte-for-byte, never parses/filters/truncates, append-only.
- **Markdown** (`layers/markdown.rs`) — human-readable mirror, derived. MAY
  truncate large tool bodies (bounded by `max_tool_output_length`) since the
  untruncated original always lives in raw.
- **SQLite/FTS** (`db.rs`) — full-text search index, derived. Tables:
  `sessions`, `messages`, `tool_calls`, plus a `messages_fts` FTS5 virtual table.
  WAL mode enabled.

Derived layers can be deleted and rebuilt entirely from raw (`chronicle rebuild`)
— raw is always the source of truth. The `jsonl.rs` parser is deliberately
permissive: unknown shapes yield no entries rather than errors, so transcript
format drift degrades derived layers gracefully without ever risking raw.

### Store layout (`~/.chronicle` by default)

```
~/.chronicle/
  bin/chronicle                   the installed binary (daemon + plugin both use it)
  config.json                     settings
  heartbeat.json                  { pid, started_at, last_sync }  ← watchdog reads this
  state/offsets.json              per-file byte offsets (restart-safe capture)
  raw/<project>/<session>.jsonl   verbatim archive (ground truth)
  markdown/<YYYY-MM-DD>/*.md       rendered mirror
  index.db                        SQLite + FTS5
```

### Watchdog

`chronicle watchdog` (invoked by the SessionStart hook) reads `heartbeat.json`
and checks process liveness + freshness. It is **non-destructive and always
exits 0** — a monitoring failure must never affect capture (which runs in the
separate daemon). The worst case is a missed warning.

## Configuration

Global config at `<store_dir>/config.json` (see `src/config.rs` for the full
model). Key fields:

```json
{
  "enabled": true,
  "store_dir": "~/.chronicle",
  "watch_dirs": ["~/.claude/projects"],
  "layers": { "raw": true, "markdown": true, "sqlite": true },
  "capture": { "mode": "live" },
  "exclude_projects": [],
  "exclude_tools": [],
  "max_tool_output_length": 2000,
  "index_debounce_ms": 30000,
  "staleness_secs": 7200,
  "debug": false
}
```

`capture.mode` is `"live"` (filesystem-watch) or `"poll"` (with `interval_ms`).
Raw capture is **never** truncated; `max_tool_output_length` bounds only markdown.

## Code Quality

- **Run the checks CI runs** — `cargo build`, `cargo test`, and
  `cargo clippy -- -D warnings` (clippy warnings fail the build).
- **Tests** live in `tests/` (integration, exercising the library crate) and as
  `#[cfg(test)]` unit modules (e.g. the `jsonl` parser).

## Key Design Decisions

- **External daemon, not hooks** — capture is hook-independent, so it survives
  silent hook failures, `/exit`, `/compact`, and Claude Code's own retention
  deletion.
- **Raw is ground truth** — every other layer is derived and rebuildable; the
  `rebuild` command and `tests/layers.rs` prove it.
- **Restart-safe capture** — newline-boundary offsets persisted atomically
  (temp file + rename); trailing partial lines are buffered, never committed.
- **Single-source-of-truth binary** — installed at `~/.chronicle/bin/chronicle`;
  daemon service and plugin reference it by absolute path so they can't version-
  skew. The plugin does not bundle its own binary. Override with `CHRONICLE_HOME`.
- **Fail-safe watchdog** — always exits 0; monitoring never blocks a session.
- **No heavy deps** — `notify`, `rusqlite` (bundled SQLite), `serde`, `clap`,
  `chrono`, `anyhow`, `dirs`.
- **Migration path** — `chronicle migrate` preserves an old `~/.claude-logs`
  store (markdown + legacy SQLite) under the Chronicle store rather than losing
  sessions Claude Code may since have deleted.
