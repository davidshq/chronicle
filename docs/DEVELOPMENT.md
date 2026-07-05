# Development Guide

How to set up, develop, test, and release changes to **Chronicle** — the external
lossless recorder for Claude Code sessions (a Rust binary + a thin plugin).

## Prerequisites

- A stable Rust toolchain (`rustup`), edition 2021
- Git
- Claude Code CLI (for testing the plugin end-to-end)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

No system SQLite is required — `rusqlite` builds a bundled copy.

## Getting Started

```bash
git clone https://github.com/davidshq/chronicle.git
cd chronicle
cargo build
```

### Run the binary directly

```bash
# Capture everything once and exit (safe, no watching) — the quickest smoke test
cargo run -- daemon --once

# Live capture (filesystem-watch); Ctrl-C to stop
cargo run -- daemon

# Query / inspect
cargo run -- status
cargo run -- status --today
cargo run -- search "some query"
cargo run -- watchdog --json

# Work against a throwaway store instead of ~/.chronicle
cargo run -- daemon --once --store /tmp/chronicle-dev
cargo run -- status --store /tmp/chronicle-dev
```

`--store <dir>` is the key development flag: every subcommand accepts it, so you
can exercise the full pipeline without touching your real `~/.chronicle`.

### Run tests

```bash
cargo test
```

The suite is split into:

- `tests/capture.rs` — verbatim copy, restart-safe resume, partial-line buffering,
  `scan_all` discovery.
- `tests/layers.rs` — raw-only vs all-layers, rebuild-from-raw, raw surviving
  source deletion.
- `tests/watchdog.rs` — health `Down` / `Healthy` / `Stale` evaluation.
- `tests/common/mod.rs` — shared helpers (`test_config`, `line`, layer presets).
- Unit tests live inline (e.g. the `#[cfg(test)] mod tests` in `src/jsonl.rs`).

Integration tests exercise the **library crate** (`src/lib.rs`), so keep public
APIs that tests rely on exported there.

### Lint

```bash
cargo clippy -- -D warnings
```

CI treats clippy warnings as errors — run this before pushing.

## Project Structure

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
│   ├── main.rs               # CLI entry (clap subcommand dispatch)
│   ├── lib.rs                # library crate root
│   ├── config.rs             # Config model + load/save
│   ├── db.rs                 # SQLite + FTS5 index
│   ├── jsonl.rs              # lenient transcript parser
│   ├── store.rs              # store layout, heartbeat, process liveness
│   ├── capture/              # engine + offset + watch/poll triggers
│   ├── layers/               # raw + markdown
│   └── commands/             # daemon, search, status, watchdog, migrate, rebuild
├── tests/                    # integration tests
├── openspec/                 # design rationale for the rewrite
└── docs/                     # ARCHITECTURE, DEVELOPMENT, TODO, CODE-REVIEW,
                              # PLUGIN-BEST-PRACTICES
```

## Development Workflow

1. Branch (optional for small fixes):
   ```bash
   git checkout -b feature/my-feature
   ```
2. Make your changes.
3. Build, test, lint:
   ```bash
   cargo build && cargo test && cargo clippy -- -D warnings
   ```
4. Exercise the real pipeline against a scratch store:
   ```bash
   cargo run -- daemon --once --store /tmp/chronicle-dev
   cargo run -- status --store /tmp/chronicle-dev
   ```
5. Commit with a descriptive message.

### Testing the plugin inside Claude Code

The slash commands and the SessionStart watchdog call the binary by absolute path
(`${CHRONICLE_HOME:-$HOME/.chronicle}/bin/chronicle`). To test them live:

```bash
# Put a fresh build where the plugin expects it
mkdir -p ~/.chronicle/bin
cp target/debug/chronicle ~/.chronicle/bin/chronicle

# Load the plugin from this checkout
claude --plugin-dir .
```

Point `CHRONICLE_HOME` at a scratch dir to avoid touching your real store while
testing (`CHRONICLE_HOME=/tmp/chronicle-dev claude --plugin-dir .`).

## Debugging

### Inspect the store

```bash
STORE="${CHRONICLE_HOME:-$HOME/.chronicle}"

# Health
cargo run -- watchdog --json --store "$STORE"

# Heartbeat + offsets
cat "$STORE/heartbeat.json"
cat "$STORE/state/offsets.json"

# The raw ground truth
ls -R "$STORE/raw"

# Query the index directly
sqlite3 "$STORE/index.db" \
  "SELECT id, project_path, started_at, message_count FROM sessions ORDER BY started_at DESC LIMIT 5;"
```

### Rebuild derived layers from raw

If the index or markdown looks wrong, prove raw is intact by regenerating from it:

```bash
cargo run -- rebuild --store "$STORE"
```

This drops `index.db` and `markdown/`, then replays `raw/` through the derived
layers with an isolated offsets file (the daemon's own offsets are untouched).

### Database locked errors

The index uses WAL mode with a busy timeout. If a stray lock lingers during
development:

```bash
sqlite3 "$STORE/index.db" "PRAGMA wal_checkpoint(TRUNCATE);"
```

## Versioning & Release

`Cargo.toml`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`
share a version — keep them in sync when bumping.

1. Update the version in those three files.
2. `cargo build && cargo test && cargo clippy -- -D warnings`.
3. Commit and tag:
   ```bash
   git commit -am "Release vX.Y.Z"
   git tag vX.Y.Z && git push --tags
   ```
4. CI's `release-binaries` job builds per-target binaries on tag pushes
   (`refs/tags/v*`).

**Note:** Claude Code caches plugins by version, so a plugin-facing change (hook
or command) that ships without a version bump may not reach users who run
`plugin marketplace update`.

## Code Conventions

- **Never truncate raw.** Truncation bounds (`max_tool_output_length`) apply to
  the markdown layer only.
- **Derived layers must be rebuildable** — anything written to `markdown/` or
  `index.db` must be reconstructable from `raw/` alone.
- **Offsets advance only on newline boundaries** and are persisted atomically;
  don't introduce a path that advances past a partial line.
- **The watchdog and plugin commands must not fail the session** — keep the
  watchdog exiting 0.
- **Prefer `anyhow::Result` with `.context(...)`** for I/O error messages, as the
  existing code does.

## Contributing

1. Fork and branch.
2. Make changes with tests.
3. Ensure `cargo test` and `cargo clippy -- -D warnings` pass.
4. Open a pull request.

For bug reports and feature requests, open an issue on GitHub. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the system design and
[TODO.md](./TODO.md) for planned work.
