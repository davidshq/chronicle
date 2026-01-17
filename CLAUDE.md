# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Session Logger is a **Claude Code plugin** that intercepts all conversation events via the hooks system and persists them to:
1. **Markdown files** - Human-readable logs organized by date and session
2. **SQLite database** - Structured, queryable storage for analytics

The plugin is distributed via GitHub marketplace and installed with:
```
claude plugin marketplace add davidshq/claude-remember
claude plugin install claude-remember@claude-remember
```

## Commands

```bash
# Install the plugin (users)
claude plugin marketplace add davidshq/claude-remember
claude plugin install claude-remember@claude-remember

# Uninstall
claude plugin uninstall claude-remember@claude-remember

# Development: test with plugin loaded locally
claude --plugin-dir .

# Run tests
bun test

# Debug - manually test handler with mock event
echo '{"hook_event_name":"SessionStart","session_id":"test","cwd":"/tmp","source":"startup"}' | bun run src/handler.ts
```

## Plugin Structure

```
claude-remember/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── hooks/
│   └── hooks.json            # Hook event definitions
├── commands/
│   ├── status.md             # /claude-remember:status
│   ├── search.md             # /claude-remember:search
│   └── today.md              # /claude-remember:today
├── src/
│   ├── handler.ts            # Main hook handler
│   ├── db.ts                 # SQLite operations
│   ├── markdown.ts           # Markdown generation
│   ├── transcript.ts         # Transcript parsing
│   ├── config.ts             # Configuration loading
│   └── types.ts              # TypeScript interfaces
├── scripts/
│   └── bump-version.ts       # Version management (bun run version)
└── docs/
    ├── ARCHITECTURE.md       # System architecture
    ├── DEVELOPMENT.md        # Developer guide
    └── PLUGIN-BEST-PRACTICES.md  # Guide to writing plugins
```

## Architecture

### Data Flow

```
Claude Code Plugin System → hooks.json → handler.ts → db.ts + markdown.ts → ~/.claude-logs/
```

### Core Modules

- **`src/handler.ts`** - Main entry point. Routes hook events to handlers, reads stdin, manages session state.
- **`src/db.ts`** - SQLite operations using Bun's built-in `bun:sqlite`. Creates/migrates schema, provides CRUD for sessions, messages, tool_calls, events.
- **`src/markdown.ts`** - Generates markdown files. Handles tool input formatting, session resume markers, file finalization.
- **`src/transcript.ts`** - Parses Claude's JSONL transcript files to extract assistant responses on `Stop` events.
- **`src/config.ts`** - Configuration management. Loads from `~/.claude-logs/config.json`, provides defaults, handles exclusions.
- **`src/types.ts`** - TypeScript interfaces for all hook event types and database models.

### Hook Events Handled

| Event | Handler Action |
|-------|---------------|
| `SessionStart` | Creates session record, initializes markdown file |
| `SessionEnd` | Marks session complete, finalizes markdown |
| `UserPromptSubmit` | Logs user message |
| `PreToolUse` | Logs tool call with inputs, starts timing |
| `PostToolUse` | Updates tool success/duration |
| `Stop` | Extracts assistant response from transcript |
| `SubagentStop` | Records subagent completion |
| `Notification` | Logs permission prompts, auth events |
| `PermissionRequest` | Logs tool permission requests |
| `PreCompact` | Backs up transcript before context compaction |

### Database Schema

SQLite at `~/.claude-logs/sessions.db` with tables: `sessions`, `messages`, `tool_calls`, `events`, `transcript_backups`. WAL mode enabled by default for concurrent access.

### Output Structure

```
~/.claude-logs/
├── sessions.db
├── config.json (optional)
├── backups/          (transcript backups from PreCompact)
└── sessions/
    └── YYYY-MM-DD/   (local timezone)
        └── {seq}_{HHMMSS}_{session_id_prefix}_{project}.md
```

File naming: `01_143045_b5bc68c9_claude-remember.md` = first session of the day, started at 14:30:45, session ID starting with b5bc68c9, in the claude-remember project.

### Configuration

**Global config** at `~/.claude-logs/config.json`:

```json
{
  "logDir": "~/.claude-logs",
  "includeToolOutputs": true,
  "maxToolOutputLength": 2000,
  "enableWAL": true,
  "excludeTools": [],
  "excludeProjects": [],
  "debug": false,
  "blockOnFailure": false,   // Exit non-zero on failure (blocks Claude)
  "maxRetries": 3,           // Auto-retry attempts before giving up
  "retryDelayMs": 2000,      // Delay between retries in ms
  "maxSearchDays": 7         // Days to search when finding session files
}
```

**Per-project config** at `.claude-remember.json` in project root:

```json
{
  "enabled": true,      // Master switch (default: true)
  "logDir": "/path",    // Custom log directory
  "dbPath": "/path/db", // Custom SQLite path (for data isolation)
  "markdown": true,     // Enable markdown logging
  "sqlite": true        // Enable SQLite logging
}
```

Any global option can also be set per-project to override.

**Deterministic commands** (intercepted by hook, run exact code):
- `/claude-remember:disable` or "disable remember logging" - creates config with `enabled: false`
- `/claude-remember:enable` or "enable remember logging" - removes config to re-enable
- `/claude-remember:retry` or "retry remember logging" - retries any failed events

**LLM-interpreted commands** (Claude interprets the prompt):
- `/claude-remember:status` - shows logging status and recent sessions
- `/claude-remember:search <query>` - searches past sessions
- `/claude-remember:today` - lists today's sessions

## Code Quality

- **Check for deprecated APIs** - Before using Bun APIs, verify they aren't deprecated by checking type definitions (look for `@deprecated` JSDoc tags). Use `db.run()` not `db.exec()`, etc.
- **Run type checker** - Use `bunx tsc --noEmit` to catch type errors before committing
- **Run tests** - Use `bun test` to run the test suite (80 tests across 5 files)
- **Strict mode enabled** - `tsconfig.json` has strict mode; don't use `any` types

## Key Design Decisions

- **Proper Claude Code plugin** - Uses `.claude-plugin/plugin.json` manifest and `hooks/hooks.json` for portable, shareable distribution
- **Symlink installation** - Plugin installed as symlink at `~/.claude/plugins/` allowing live development without reinstall
- **Hybrid slash commands** - Deterministic commands (`/disable`, `/enable`, `/retry`) handled by hook; LLM-interpreted commands (`/status`, `/search`, `/today`) for exploration
- **Bun runtime** - Sub-100ms startup time critical for hook performance
- **No external dependencies** - Uses only Bun built-ins (`bun:sqlite`, native fs)
- **Fail-safe** - Handler always exits 0 to never block Claude Code; errors logged to stderr (configurable with `blockOnFailure`)
- **Automatic retry** - Failed logging attempts retry with configurable delay and max attempts
- **Database corruption recovery** - Corrupt databases are backed up and recreated automatically
- **Deduplication** - Tracks `lastAssistantContent` to avoid duplicate transcript parsing
- **Cross-process recovery** - `ensureSession()` recreates missing session state if hooks fire out of order
- **Local timezone for directories** - Date folders use local time (via `toLocaleDateString`) so "today's" sessions appear in today's folder; timestamps in DB/markdown remain UTC
- **Per-project config** - `.claude-remember.json` in project root overrides global settings; can disable logging or redirect output per-project
