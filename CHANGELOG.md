# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
