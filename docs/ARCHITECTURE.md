# Architecture

This document describes the architecture of Claude Session Logger, a plugin that captures Claude Code conversations and persists them to markdown files and a SQLite database.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Claude Code                                    │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Session  │  │  User    │  │  Tool    │  │  Tool    │  │  Stop    │  │
│  │  Start   │  │ Prompt   │  │  Pre     │  │  Post    │  │  Event   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
└───────┼─────────────┼─────────────┼─────────────┼─────────────┼────────┘
        │             │             │             │             │
        └─────────────┴─────────────┴─────────────┴─────────────┘
                                    │
                              Hook Events
                             (stdin JSON)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         handler.ts                                       │
│                                                                          │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │
│   │   Event     │───▶│   Route     │───▶│  Handler    │                 │
│   │   Parser    │    │   Switch    │    │  Functions  │                 │
│   └─────────────┘    └─────────────┘    └──────┬──────┘                 │
│                                                 │                        │
└─────────────────────────────────────────────────┼────────────────────────┘
                                                  │
                          ┌───────────────────────┼───────────────────────┐
                          │                       │                       │
                          ▼                       ▼                       ▼
                   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐
                   │   db.ts     │         │ markdown.ts │         │transcript.ts│
                   │             │         │             │         │             │
                   │  SQLite     │         │  Markdown   │         │  Transcript │
                   │  Storage    │         │  Writer     │         │  Parser     │
                   └──────┬──────┘         └──────┬──────┘         └─────────────┘
                          │                       │
                          ▼                       ▼
                   ┌─────────────┐         ┌─────────────────────────────┐
                   │sessions.db  │         │ sessions/YYYY-MM-DD/*.md    │
                   └─────────────┘         └─────────────────────────────┘
```

## Plugin Architecture

Claude Code plugins use a standardized structure:

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json    # Manifest: name, version, commands path, hooks path
├── hooks/
│   └── hooks.json     # Hook event → command mappings
└── commands/
    └── *.md           # Slash command prompts (LLM-interpreted)
```

**Key concepts:**

| Concept | Description |
|---------|-------------|
| `plugin.json` | Declares plugin metadata and paths to commands/hooks |
| `hooks.json` | Maps hook events to shell commands (run via stdin) |
| `${CLAUDE_PLUGIN_ROOT}` | Environment variable pointing to plugin directory |
| Commands directory | Markdown files become `/plugin-name:command` slash commands |
| Symlink installation | Plugin directory symlinked to `~/.claude/plugins/` |

**Command types:**

1. **LLM-interpreted** (`commands/*.md`): Claude receives the prompt and decides what to do
2. **Deterministic** (handler intercepts): Hook code detects patterns and runs exact logic

This plugin uses both: `/status`, `/search`, `/today` are LLM-interpreted; `/disable`, `/enable`, `/retry` are deterministic (intercepted by `handler.ts` on `UserPromptSubmit`).

## Data Flow

### 1. Hook Invocation

Claude Code invokes the handler for each hook event, passing JSON via stdin:

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "abc123...",
  "cwd": "/path/to/project",
  "transcript_path": "/path/to/.claude/projects/.../transcript.jsonl",
  "prompt": "Help me fix the bug"
}
```

### 2. Event Processing

The handler (`src/handler.ts`) performs these steps:

1. **Read stdin** - Parse JSON input
2. **Check exclusions** - Skip if project or tool is excluded
3. **Check project config** - Load `.claude-remember.json` if present
4. **Ensure session** - Create session record if missing (handles out-of-order hooks)
5. **Route event** - Call appropriate handler function
6. **Write outputs** - Update database and/or markdown (based on config)
7. **Exit cleanly** - Always exit 0 to never block Claude

### 3. Per-Project Configuration

Each project can have a `.claude-remember.json` in its root:

```json
{
  "enabled": true,      // Master switch (default: true)
  "logDir": "/path",    // Custom log directory for markdown files and backups
  "dbPath": "/path/db", // Custom SQLite database path
  "markdown": true,     // Enable markdown logging (default: true)
  "sqlite": true        // Enable SQLite logging (default: true)
}
```

**Key functions in handler.ts:**
- `getProjectConfig()` - Load and parse `.claude-remember.json`
- `isProjectLoggingEnabled()` - Check if `enabled !== false`
- `isMarkdownEnabled()` - Check if `markdown !== false`
- `isSqliteEnabled()` - Check if `sqlite !== false`
- `getProjectLogDir()` - Get custom `logDir` if configured
- `getProjectDbPath()` - Get custom `dbPath` if configured

**User command:** Saying "disable remember logging" creates `.claude-remember.json` with `enabled: false`.

### 4. Dual Storage

Events are written to one or both storage backends (based on config):

| Backend | Purpose | Format |
|---------|---------|--------|
| SQLite | Querying, analytics, structured data | Normalized tables with foreign keys |
| Markdown | Human reading, git history, sharing | Formatted text with headers and code blocks |

## Components

### handler.ts

The main entry point and event router.

**Responsibilities:**
- Read and parse stdin JSON
- Route events to handler functions
- Manage in-memory session state (for deduplication)
- Track tool call timing

**Key functions:**
- `handleSessionStart()` - Create session, initialize markdown
- `handleUserPromptSubmit()` - Log user messages
- `handlePreToolUse()` - Log tool calls, start timing
- `handlePostToolUse()` - Update tool results
- `handleStop()` - Extract assistant response from transcript
- `ensureSession()` - Create session if missing (handles out-of-order hooks)

### db.ts

SQLite database operations using Bun's built-in `bun:sqlite`.

**Schema:**

```sql
sessions
├── id TEXT PRIMARY KEY
├── project_path TEXT
├── started_at TEXT
├── ended_at TEXT
├── status TEXT (active|completed|interrupted)
├── message_count INTEGER
├── interface TEXT (cli|vscode|web)
└── markdown_path TEXT

messages
├── id INTEGER PRIMARY KEY
├── session_id TEXT (FK)
├── timestamp TEXT
├── role TEXT (user|assistant|system|tool)
├── content TEXT
├── tool_name TEXT
├── tool_input TEXT
└── tool_output TEXT

tool_calls
├── id INTEGER PRIMARY KEY
├── session_id TEXT (FK)
├── timestamp TEXT
├── tool_name TEXT
├── input_summary TEXT
├── success INTEGER
└── duration_ms INTEGER

events
├── id INTEGER PRIMARY KEY
├── session_id TEXT (FK)
├── timestamp TEXT
├── event_type TEXT
├── subtype TEXT
├── tool_name TEXT
├── message TEXT
└── metadata TEXT

transcript_backups
├── id INTEGER PRIMARY KEY
├── session_id TEXT (FK)
├── timestamp TEXT
├── trigger TEXT
├── transcript_path TEXT
└── backup_path TEXT
```

**Features:**
- WAL mode for concurrent access
- Auto-migration for schema changes
- Prepared statements for performance
- Multi-database support: caches connections by path for per-project databases

### markdown.ts

Generates human-readable markdown files.

**File naming:** `{sequence}_{HHMMSS}_{session_id}_{project}.md`

Example: `01_143045_b5bc68c9_my-project.md`
- `01` - First session of the day
- `143045` - Started at 14:30:45 local time
- `b5bc68c9` - First 8 chars of session ID
- `my-project` - Project folder name

**Session recovery strategies:**
1. In-memory cache (same process)
2. Database `markdown_path` column (cross-process)
3. Filename search by session ID (fallback)

**Tool formatting:**
- Bash: Shows command and description
- Read/Write/Edit: Shows file path and content (truncated)
- Glob/Grep: Shows pattern
- WebFetch/WebSearch: Shows URL/query
- Others: JSON dump

### transcript.ts

Parses Claude's JSONL transcript files.

Used on `Stop` events to extract the assistant's response, since the hook doesn't include it directly.

**Parsing handles:**
- Multiple content block formats (text, tool_use, tool_result)
- Different transcript entry structures
- Malformed lines (skipped gracefully)

### config.ts

Configuration management.

**Defaults:**
```typescript
{
  logDir: "~/.claude-logs",
  dbPath: "~/.claude-logs/sessions.db",
  includeToolOutputs: true,
  maxToolOutputLength: 2000,
  enableWAL: true,
  excludeTools: [],
  excludeProjects: [],
  debug: false
}
```

**Custom config:** Create `~/.claude-logs/config.json`

### types.ts

TypeScript interfaces for:
- All 10 hook event input types
- Database record types
- Tool input types (Bash, Read, Write, Edit, etc.)
- Transcript message formats

## Design Decisions

### Why Bun?

Hook handlers must be fast (<100ms). Bun provides:
- Sub-100ms cold start (vs ~300ms for Node.js)
- Built-in SQLite (`bun:sqlite`)
- Native TypeScript execution
- Fast file I/O

### Why dual storage?

| Use Case | Best Backend |
|----------|--------------|
| "What did I do yesterday?" | Markdown (browse files) |
| "How often do I use Bash?" | SQLite (query) |
| "Show me session X" | Either |
| "Share this conversation" | Markdown (copy file) |
| "Build analytics dashboard" | SQLite (structured) |
| "Keep client data separate" | Per-project dbPath |

### Why always exit 0?

The handler should never block Claude Code. If logging fails:
1. Log error to stderr
2. Exit 0 anyway
3. User continues working uninterrupted

Logging is observability, not critical path.

### Timezone handling

| What | Timezone | Why |
|------|----------|-----|
| Directory names | Local | "Today's" sessions in today's folder |
| Timestamps in DB | UTC | Standard for data storage |
| Timestamps in markdown | UTC | Consistent, unambiguous |
| File time in name | Local | Matches directory |

### Session recovery

Sessions can be resumed across process restarts:

1. **Check database** - `markdown_path` column stores full path
2. **Search directories** - Find file containing session ID
3. **Create new** - If truly new session

This handles:
- Claude Code restarts
- Hook firing out of order
- Timezone transitions (file in "wrong" date directory)

## File Structure

```
claude-remember/
├── .claude-plugin/
│   └── plugin.json       # Plugin manifest (name, version, commands, hooks paths)
├── hooks/
│   └── hooks.json        # Hook event definitions (uses ${CLAUDE_PLUGIN_ROOT})
├── commands/
│   ├── status.md         # /claude-remember:status (LLM-interpreted)
│   ├── search.md         # /claude-remember:search (LLM-interpreted)
│   └── today.md          # /claude-remember:today (LLM-interpreted)
├── src/
│   ├── handler.ts        # Entry point, event routing, deterministic commands
│   ├── db.ts             # SQLite operations
│   ├── markdown.ts       # Markdown generation
│   ├── transcript.ts     # Transcript parsing
│   ├── config.ts         # Configuration
│   └── types.ts          # TypeScript interfaces
├── scripts/
│   ├── install.ts        # Create symlink, enable plugin
│   └── uninstall.ts      # Remove symlink, disable plugin
├── docs/
│   ├── ARCHITECTURE.md          # This file
│   └── PLUGIN-BEST-PRACTICES.md # Guide to writing Claude Code plugins
├── CLAUDE.md             # Claude Code guidance
├── README.md             # User documentation
└── package.json
```

**Plugin installation:**
- Symlinked to `~/.claude/plugins/claude-remember`
- Registered in `~/.claude/settings.json` as `claude-remember@local`

## Output Structure

**Default location (`~/.claude-logs/`):**

```
~/.claude-logs/
├── sessions.db                              # SQLite database (always here)
├── config.json                              # Optional global config
├── backups/                                 # Transcript backups (PreCompact)
│   └── b5bc68c9_2026-01-16T14-30-45.jsonl
└── sessions/
    ├── 2026-01-15/
    │   └── 01_093000_a1b2c3d4_project-a.md
    └── 2026-01-16/
        ├── 01_090000_b5bc68c9_project-b.md
        └── 02_143045_c6d7e8f9_project-b.md
```

**Custom logDir and dbPath (per-project):**

If a project has `.claude-remember.json` with custom paths, its data goes there instead:

```json
{
  "logDir": "/custom/path",
  "dbPath": "/custom/path/sessions.db"
}
```

```
/custom/path/
├── sessions.db                              # Project-specific SQLite database
├── backups/                                 # Project-specific transcript backups
└── sessions/
    └── 2026-01-16/
        └── 01_143045_abc12345_my-project.md
```

This allows complete data isolation between projects - useful when working with different clients whose data should not be co-mingled.
