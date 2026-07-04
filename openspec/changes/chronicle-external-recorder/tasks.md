# Tasks

Phased so the free/reliable lossless core lands first; opt-in and later-phase work follows.

## 1. Repo rename & project setup

- [ ] 1.1 Rename repo `claude-remember` → `chronicle` (preserve history/issues); update marketplace manifest identity and README — _plugin.json + marketplace.json done; README done; **GitHub repo rename still requires the user (`gh repo rename chronicle`)**_
- [x] 1.2 Create fresh rewrite branch off `main`; keep old plugin installable from a tagged pre-pivot release — _branch `chronicle-rewrite`, tag `v0.3.3-pre-chronicle`_
- [x] 1.3 Scaffold single Rust binary (`chronicle`) with git-style subcommand dispatch (`daemon` / `search` / `status` / `watchdog` / `migrate` / `rebuild`)
- [x] 1.4 Add crate deps: `notify` (filewatch), `rusqlite` (bundled SQLite+FTS5), `serde`/`serde_json`; set up CI + cross-compile targets — _`.github/workflows/ci.yml`_

## 2. Store contract (shared by writer and reader)

- [x] 2.1 Define on-disk store layout: raw JSONL archive dir, markdown mirror dir, SQLite index path, heartbeat/last-sync file — _`src/store.rs`_
- [x] 2.2 Define SQLite schema (port shape from old `db.ts`: sessions/messages/tool_calls) + FTS5 virtual table — _`src/db.rs`_
- [x] 2.3 Define config model + semantics ported from old config (per-project enable/disable, exclusions, layer toggles, live-vs-poll) — _`src/config.rs`_

## 3. Capture engine (`lossless-capture`)

- [x] 3.1 Per-file byte-offset tracker with persisted, restart-safe state (resume without re-copy or skip) — _`src/capture/offset.rs` + `engine.rs`_
- [x] 3.2 Partial-line buffering (only persist through the last newline)
- [x] 3.3 Live trigger via `notify`, incl. directory watch for new/continuation session files — _`src/capture/watch.rs`_
- [x] 3.4 Periodic-poll trigger as configurable fallback; shared engine behind both triggers — _`src/capture/poll.rs`_
- [x] 3.5 Verbatim raw-archive writer (append-only, byte-for-byte, no truncation/filtering) — _`src/layers/raw.rs`_
- [x] 3.6 Tests: continuous (hooks-independent) capture, restart resume, partial line, new-file detection — _`tests/capture.rs`_

## 4. Layered storage (`layered-storage`)

- [x] 4.1 Independently toggle raw / markdown / SQLite layers
- [x] 4.2 Markdown mirror renderer (port format from old `markdown.ts`), derived from raw — _`src/layers/markdown.rs`_
- [x] 4.3 SQLite/FTS indexer — _inserts batched per file-sync; **timed debounce via `index_debounce_ms` is a follow-up** (config field present, not yet wired to a timer)_
- [x] 4.4 Regenerate-derived-layers-from-raw command (proves raw is ground truth) — _`chronicle rebuild`_
- [x] 4.5 Tests: raw-only mode, all-layers mode, delete+rebuild derived from raw, retention-deletion survival — _`tests/layers.rs`_

## 5. Daemon lifecycle & install

- [x] 5.1 `chronicle daemon` service entry: start/stop, heartbeat + last-sync writes — _`src/commands/daemon.rs`_
- [x] 5.2 Service install/onboarding (launchd/systemd) with auto-restart; one-command installer — _`scripts/install.sh`_
- [x] 5.3 `chronicle migrate`: import existing `~/.claude-logs/` into the new store — _`src/commands/migrate.rs`_

## 6. Plugin: watchdog + retrieval (`recorder-watchdog`, `session-search`)

- [x] 6.1 `chronicle watchdog`: liveness + staleness check (process alive, heartbeat fresh); in-session warnings with configurable thresholds — _`src/commands/watchdog.rs`_
- [x] 6.2 Wire `hooks.json` (SessionStart → watchdog only) + `commands/*.md` to call `${CLAUDE_PLUGIN_ROOT}/bin/chronicle`; monitoring failure is non-destructive to capture
- [x] 6.3 `chronicle search` (FTS), `chronicle status` (health + recent), today's-sessions (`status --today`) — _`src/commands/{search,status}.rs`_
- [x] 6.4 Tests: daemon-down warning, stale-store warning, healthy state, keyword hit/miss — _`tests/watchdog.rs`_

## 7. Narrative summaries (`narrative-summaries`) — opt-in — NOT STARTED (paused for direction)

- [ ] 7.1 Opt-in config gate; zero LLM calls / zero artifacts when disabled — _config gate (`summaries.enabled`) exists; generator not built_
- [ ] 7.2 Summary generator (session boundary / on demand): rabbit-hole compression that names detours + dead-ends
- [ ] 7.3 Cross-reference anchoring: link summary statements to raw-archive line ranges; never modify raw
- [ ] 7.4 Tests: disabled-by-default, dead-end retention, drill-through to raw line range

## 8. Cutover & docs

- [x] 8.1 Validate all core spec scenarios (14 tests: capture, layers, watchdog, jsonl) + end-to-end smoke test
- [x] 8.2 Update README + manifests for Chronicle; add docs/TODO.md + README acknowledgments — _CLAUDE.md / ARCHITECTURE / DEVELOPMENT refresh still pending (tracked in docs/TODO.md)_
- [ ] 8.3 Cut `main` over to the rewrite; document rollback to the tagged pre-pivot release — _outward action, awaiting user_

## 9. Future phase (not v1)

- [ ] 9.1 Cross-tool capture adapters (Codex/Cursor/Gemini): per-tool log path + format adapter over the same capture engine
