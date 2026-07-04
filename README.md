# Chronicle

**A lossless recorder for Claude Code sessions.** Chronicle keeps a faithful,
byte-for-byte record of everything Claude Code does — and, unlike the "memory"
plugins, it never summarizes the original away.

It has two parts:

- **`chronicled`** — an external daemon that watches Claude Code's transcript
  files and records them. Because it runs *outside* Claude Code, capture does
  **not** depend on hooks firing (which [fail silently](https://github.com/anthropics/claude-code/issues/16047)
  in long sessions, on `/exit`, and during `/compact`). Your record survives
  even when Claude Code deletes its own old transcripts.
- **`chronicle` plugin** — a thin in-session layer that lets you `search` /
  `status` / `today` your history and **warns you when the recorder is down or
  stale** (a watchdog, not a capturer).

## Why not just use a memory plugin?

| | Memory plugins (claude-mem, remember, …) | **Chronicle** |
|---|---|---|
| Storage | AI-compresses sessions, discards originals (lossy) | Keeps everything verbatim (lossless) |
| Goal | Inject smaller context into the next session | A faithful archive you can go back and read |
| Capture | Hook-based (silent failures) | External daemon (hook-independent) |
| Cost | LLM calls per session | Free core; LLM summaries are opt-in |

## Storage layers (each independently opt-in)

```
raw JSONL archive   ← lossless ground truth, byte-for-byte, deletion-proof
markdown mirror     ← human-readable rendering, derived from raw
SQLite + FTS5 index ← full-text search, derived from raw
narrative summaries ← opt-in, LLM-derived, cross-referenced to raw (roadmap)
```

Derived layers can be deleted and rebuilt from the raw archive at any time
(`chronicle rebuild`) — raw is always the source of truth.

## Install

```bash
# Build + install the binary and register the capture daemon as a user service
# (systemd on Linux, launchd on macOS), and migrate any old ~/.claude-logs store:
./scripts/install.sh

# Then add the plugin (for search + the health watchdog):
claude plugin marketplace add davidshq/chronicle
claude plugin install chronicle@chronicle
```

## Usage

```bash
chronicle status              # capture health + recent sessions
chronicle status --today      # today's sessions
chronicle search "rate limiter"   # full-text search (FTS5 syntax)
chronicle daemon              # run the capture daemon in the foreground
chronicle daemon --poll       # use periodic polling instead of live watch
chronicle rebuild             # rebuild markdown + index from the raw archive
chronicle migrate             # import an old ~/.claude-logs store
```

Inside Claude Code, the plugin also provides `/chronicle:status`,
`/chronicle:search <query>`, and `/chronicle:today`.

## Store layout

```
~/.chronicle/
  config.json                     settings (layers, capture mode, exclusions…)
  heartbeat.json                  daemon liveness/freshness (read by the watchdog)
  state/offsets.json              restart-safe per-file byte offsets
  raw/<project>/<session>.jsonl   verbatim archive (ground truth)
  markdown/<YYYY-MM-DD>/*.md       rendered mirror
  index.db                        SQLite + FTS5
```

## Development

```bash
cargo build          # build
cargo test           # run the test suite
cargo clippy         # lint
```

Built in Rust as a single binary with git-style subcommands. See
`openspec/changes/chronicle-external-recorder/` for the full design rationale
(the pivot from the old hook-based `claude-remember` plugin).

## Acknowledgments

Chronicle is an independent, from-scratch implementation — no code was copied
from the projects below. They are prior art and inspiration we studied while
designing it, and credit is due:

- **[claude-vault](https://github.com/kuroko1t/claude-vault)** (kuroko1t) — the
  closest prior art: a single Rust binary that archives Claude Code sessions to
  SQLite+FTS. Chronicle differs by capturing *losslessly and live* (external
  daemon vs. hook-triggered import) and keeping raw JSONL + markdown alongside
  the index. Reading it clarified the problem space.
- **[claude-code-trace](https://github.com/delexw/claude-code-trace)** (delexw)
  — demonstrated that live-tailing Claude Code's JSONL transcripts is a solved,
  reliable technique, which de-risked our capture engine.
- **[claude-mem](https://github.com/thedotmack/claude-mem)** (thedotmack) and the
  official **remember** plugin — the lossy "memory" approach Chronicle
  deliberately contrasts with; studying them sharpened our lossless positioning.
- **[ccboard](https://github.com/FlorianBruniaux/ccboard)** — prior art for a
  Rust-based Claude Code monitoring binary.
- Jesse Vincent's writeup on
  **[Claude Code session continuation](https://blog.fsck.com/agent-blog/2026/02/22/claude-code-session-continuation/)**
  — the clearest explanation of the compaction/`compact_boundary` file mechanics
  that shaped our capture-cadence design.
- The prior **`claude-remember`** plugin (this repo's own history, tagged
  `v0.3.3-pre-chronicle`) — the hook-based ancestor whose markdown format and
  SQLite schema shape were ported into Chronicle's derived layers.

Built on excellent Rust crates:
[`notify`](https://crates.io/crates/notify),
[`rusqlite`](https://crates.io/crates/rusqlite) (bundled SQLite + FTS5),
[`clap`](https://crates.io/crates/clap),
[`serde`](https://crates.io/crates/serde) / `serde_json`,
[`chrono`](https://crates.io/crates/chrono),
[`dirs`](https://crates.io/crates/dirs),
[`anyhow`](https://crates.io/crates/anyhow).

## License

MIT

