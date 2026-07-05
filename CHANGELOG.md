# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - Chronicle (Rust rewrite)

### Changed
- **Breaking — complete pivot.** Replaced the hook-based `claude-remember`
  TypeScript/Bun plugin with **Chronicle**: an external, lossless recorder
  written in Rust as a single binary with git-style subcommands. Capture now runs
  in a standalone daemon that tails Claude Code's transcript files, so it no
  longer depends on hooks firing (which fail silently on long sessions, `/exit`,
  and `/compact`) and survives Claude Code deleting its own transcripts.

### Added
- **Capture daemon** (`chronicle daemon`) with live filesystem-watch (default)
  and periodic-poll (`--poll`) triggers, plus `--once` for one-shot capture.
- **Layered storage**, each independently opt-in: a verbatim raw JSONL archive
  (lossless ground truth), a derived markdown mirror, and a derived SQLite + FTS5
  index. Derived layers rebuild from raw via `chronicle rebuild`.
- **Restart-safe capture** via persisted newline-boundary byte offsets; trailing
  partial lines are buffered, never committed.
- **In-session plugin** as a thin client: `/chronicle:search`,
  `/chronicle:status`, `/chronicle:today`, and a SessionStart **watchdog** hook
  that warns when the recorder is down or stale (it never captures).
- **Single-source-of-truth binary** installed to the fixed anchor
  `~/.chronicle/bin/chronicle`; the daemon service and the plugin both reference
  it by absolute path, so they cannot version-skew. The store (config + data)
  lives at the anchor by default, or wherever the anchor's `store-path` pointer
  redirects (`install.sh --store <dir>`).
- `chronicle migrate` to preserve an existing `~/.claude-logs` store.
- `scripts/install.sh` to build, install, register a user service
  (systemd/launchd), and migrate.

### Removed
- The TypeScript/Bun handler, per-event hook wiring, `.claude-remember.json`
  per-project config, and the Bun test suite — superseded by the daemon and the
  Rust integration tests.

## [0.3.1] - 2026-01-17

### Added
- **Marketplace distribution** - Plugin can now be installed via:
  ```
  claude plugin marketplace add davidshq/claude-remember
  claude plugin install claude-remember@claude-remember
  ```
- `.claude-plugin/marketplace.json` for GitHub-based distribution
- `repository`, `homepage`, and `license` fields to plugin manifest
- `allowed-tools` frontmatter to all slash commands (prevents permission prompts)
- `docs/PLUGIN-BEST-PRACTICES.md` - Comprehensive guide to writing Claude Code plugins

### Fixed
- `search.md` frontmatter: changed non-standard `argument_name` to `argument-hint`

### Removed
- Explicit `commands` and `hooks` paths from plugin.json (auto-discovered from standard locations)

## [0.3.0] - 2026-01-16

### Changed
- **Breaking:** Converted to proper Claude Code plugin architecture
  - Now uses `.claude-plugin/plugin.json` manifest for portable, shareable distribution
  - Hook definitions moved to `hooks/hooks.json` (uses `${CLAUDE_PLUGIN_ROOT}` variable)
  - Plugin installed as symlink at `~/.claude/plugins/claude-remember`
  - Registered in settings as `claude-remember@local`

### Added
- **LLM-interpreted slash commands** via `commands/` directory:
  - `/claude-remember:status` - View logging status and recent sessions
  - `/claude-remember:search <query>` - Search past sessions by keyword
  - `/claude-remember:today` - List all sessions from today
- **Deterministic commands** (handled directly by hook):
  - `/claude-remember:disable` (alias: `/remember:disable`) - Disable logging for project
  - `/claude-remember:enable` (alias: `/remember:enable`) - Re-enable logging
  - `/claude-remember:retry` (alias: `/remember:retry`) - Retry failed events
- Natural language command detection ("disable remember logging", etc.)

### Removed
- Legacy hook configuration in `~/.claude/settings.json` (migrated to plugin system)

## [0.2.0] - 2026-01-16

### Fixed
- **Critical:** Database corruption when multiple hook processes write simultaneously
  - Added `PRAGMA busy_timeout = 5000` to wait for locks instead of failing immediately
  - Added `PRAGMA synchronous = NORMAL` for safe WAL mode performance
  - Restructured handler to always close database connections via `finally` block

### Added
- Regression tests for database concurrent access (spawns 5 simultaneous writers)
- Tests verifying `busy_timeout`, WAL mode, and synchronous mode are configured correctly

## [0.1.0] - 2026-01-16

### Added
- Initial release of Claude Session Logger
- Hook handlers for all Claude Code events:
  - `SessionStart`, `SessionEnd`
  - `UserPromptSubmit`
  - `PreToolUse`, `PostToolUse`
  - `Stop`, `SubagentStop`
  - `Notification`, `PermissionRequest`
  - `PreCompact` (transcript backup)
- SQLite database logging with WAL mode
- Markdown file logging organized by date
- Per-project configuration via `.claude-remember.json`
- Global configuration via `~/.claude-logs/config.json`
- Automatic retry logic for failed logging attempts
- Database corruption recovery (backup and recreate)
- Session resume detection across process restarts
- Test suite with 69 tests across 5 test files
- TypeScript strict mode enabled

### Configuration Options
- `enabled` - Master switch for logging
- `logDir` - Custom log directory
- `dbPath` - Custom SQLite database path
- `markdown` - Enable/disable markdown logging
- `sqlite` - Enable/disable SQLite logging
- `excludeTools` - Tools to exclude from logging
- `excludeProjects` - Projects to exclude from logging
- `blockOnFailure` - Whether to block Claude on logging failure
- `maxRetries` - Number of retry attempts
- `retryDelayMs` - Delay between retries
