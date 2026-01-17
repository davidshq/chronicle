# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Session Logger is a Claude Code plugin that intercepts all conversation events via the hooks system and persists them to:
1. **Markdown files** - Human-readable logs organized by date and session
2. **SQLite database** - Structured, queryable storage for analytics

The plugin runs as a Bun process invoked by Claude Code's hook system. It receives JSON via stdin and writes to `~/.claude-logs/`.

## Commands

```bash
# Install dependencies
bun install

# Install hooks into ~/.claude/settings.json
bun run install-hooks

# Uninstall hooks (preserves log files)
bun run uninstall-hooks

# Run tests
bun test

# Debug - manually test handler with mock event
echo '{"hook_event_name":"SessionStart","session_id":"test","cwd":"/tmp","source":"startup"}' | bun run src/handler.ts
```

## Architecture

### Data Flow

```
Claude Code Hooks → stdin (JSON) → handler.ts → db.ts + markdown.ts → ~/.claude-logs/
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

### Per-Project Configuration

Projects can have a `.claude-remember.json` in their root:

```json
{
  "enabled": true,      // Master switch (default: true)
  "logDir": "/path",    // Custom log directory for markdown files and backups
  "dbPath": "/path/db", // Custom SQLite database path
  "markdown": true,     // Enable markdown logging (default: true)
  "sqlite": true        // Enable SQLite logging (default: true)
}
```

- User can say "disable remember logging" to create this file with `enabled: false`
- Custom `logDir` affects markdown files and transcript backups
- Custom `dbPath` allows complete data isolation between projects (useful for client work)
- Each handler checks `isMarkdownEnabled()` and `isSqliteEnabled()` before writing
- The db.ts module caches multiple database connections by path

## Key Design Decisions

- **Bun runtime** - Sub-100ms startup time critical for hook performance
- **No external dependencies** - Uses only Bun built-ins (`bun:sqlite`, native fs)
- **Fail-safe** - Handler always exits 0 to never block Claude Code; errors logged to stderr
- **Deduplication** - Tracks `lastAssistantContent` to avoid duplicate transcript parsing
- **Cross-process recovery** - `ensureSession()` recreates missing session state if hooks fire out of order
- **Local timezone for directories** - Date folders use local time (via `toLocaleDateString`) so "today's" sessions appear in today's folder; timestamps in DB/markdown remain UTC
- **Per-project config** - `.claude-remember.json` in project root overrides global settings; can disable logging or redirect output per-project
