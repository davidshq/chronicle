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

Installation is two steps: the **binary + daemon** (does the actual capturing),
then the **plugin** (a thin in-session client — `search` / `status` / `today` and
the health watchdog — that shells out to the installed binary).

```bash
# 1. Build + install the binary to ~/.chronicle/bin, register the capture daemon
#    as a user service (systemd on Linux, launchd on macOS), and migrate any old
#    ~/.claude-logs store:
./scripts/install.sh

# 2. Add the plugin. It calls the binary installed in step 1 by absolute path
#    (~/.chronicle/bin/chronicle), so step 1 is a prerequisite — the plugin does
#    not bundle its own binary, which keeps it from ever drifting to a different
#    version than the daemon writing your store.
claude plugin marketplace add davidshq/chronicle
claude plugin install chronicle@chronicle
```

> The plugin cannot install the capture daemon itself (it's a background system
> service, outside Claude Code's reach), so `./scripts/install.sh` is required
> even though the plugin is added separately.

### Storing your data somewhere else

By default the store — config plus the bulky `raw/`, `markdown/`, and `index.db`
— lives under `~/.chronicle`. To put it elsewhere (a bigger disk, an encrypted
volume, a synced folder), pass **`--store`** when you install:

```bash
./scripts/install.sh --store /mnt/data/chronicle
```

`~/.chronicle` stays as a small fixed **anchor** — it keeps the binary and a
one-line `store-path` file pointing at your real store. Every invocation (the
daemon, `chronicle status`, the plugin's watchdog) reads that pointer to find
the store, so they all agree with **nothing to export and nothing to keep in
sync** — a pointer can't drift from what it points at. The config file itself
lives *in* the store, so it stays self-contained and movable as a unit.

You can still point any single command at a store ad hoc with `--store <dir>`,
which overrides the pointer (this is how the tests use throwaway stores). The
`store_dir` field in `config.json` is **not** a relocation knob — it's resolved
from the pointer/`--store` at load time and overwritten, since the config lives
inside the store it would be describing.

**Moving an existing store:** stop the daemon, move the store, then reinstall
pointed at the new location. Reinstall recreates the `~/.chronicle` anchor (a
fresh binary + the `store-path` pointer), so the daemon and plugin follow along:

```bash
systemctl --user stop chronicle          # (Linux; on macOS: launchctl unload …)
mv ~/.chronicle /mnt/data/chronicle
./scripts/install.sh --store /mnt/data/chronicle
```

The data moves intact, so no `rebuild` is needed — though `chronicle rebuild`
regenerates the derived layers from raw at any time if you want to be sure.

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
~/.chronicle/                     fixed anchor (always here)
  bin/chronicle                   the installed binary (used by daemon + plugin)
  store-path                      one-line pointer to the store (absent ⇒ store is here)

<store>/                          the anchor itself, or wherever store-path points
  config.json                     settings (layers, capture mode, exclusions…)
  heartbeat.json                  daemon liveness/freshness (read by the watchdog)
  state/offsets.json              restart-safe per-file byte offsets
  raw/<project>/<session>.jsonl        verbatim archive (ground truth)
  markdown/<project>/<YYYY-MM-DD>/*.md  rendered mirror
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

## License

MIT

