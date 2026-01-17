# Claude Session Logger

A Claude Code plugin that intercepts all conversation logs and saves them:
1. **As markdown files** - Human-readable, organized by date and session
2. **Into a SQLite database** - Structured, queryable, analytics-ready

Works with both **CLI** and **VS Code extension** - they share the same configuration.

## Installation

### Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0.0 or later)

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

### Install the Plugin

```bash
# Clone or download this repository
cd /path/to/claude-remember

# Install dependencies
bun install

# Run the installation script
bun run install-hooks
```

This will add the necessary hooks to your `~/.claude/settings.json`.

### Uninstall

```bash
bun run uninstall-hooks
```

This removes the hooks but preserves your log files.

## Output

### Markdown Files

Located at `~/.claude-logs/sessions/YYYY-MM-DD/`:

```
~/.claude-logs/
├── sessions/
│   ├── 2026-01-16/
│   │   ├── 01_093045_abc12345_my-project.md
│   │   └── 02_143022_def67890_other-project.md
│   └── 2026-01-17/
│       └── 01_101530_ghi11111_my-project.md
└── sessions.db
```

Files are named `{sequence}_{HHMMSS}_{session_id}_{project}.md` where sequence is the session number for that day, HHMMSS is the start time, and session_id is the first 8 characters of the Claude session ID.

Each markdown file contains:
- Session metadata (project path, start time, status)
- User messages with timestamps
- Tool calls with formatted inputs
- Tool results (success/failure, optional output)
- Assistant responses

### SQLite Database

Located at `~/.claude-logs/sessions.db` with five tables:

**sessions**
- `id` - Session ID
- `project_path` - Project directory
- `started_at` / `ended_at` - Timestamps
- `status` - active/completed/interrupted
- `interface` - cli/vscode/web
- `markdown_path` - Path to the markdown log file

**messages**
- `session_id` - Foreign key to sessions
- `timestamp` - When the message was recorded
- `role` - user/assistant/system/tool
- `content` - Message content
- `tool_name` / `tool_input` / `tool_output` - For tool calls

**tool_calls**
- `session_id` - Foreign key to sessions
- `tool_name` - Name of the tool
- `input_summary` - Brief summary of input
- `success` - Whether the tool succeeded
- `duration_ms` - Execution time

**events**
- `session_id` - Foreign key to sessions
- `timestamp` - When the event occurred
- `event_type` - notification/permission_request/pre_compact/subagent_stop
- `subtype` - Event-specific subtype
- `tool_name` - Tool involved (if applicable)
- `message` - Event message or description

**transcript_backups**
- `session_id` - Foreign key to sessions
- `timestamp` - When the backup was created
- `trigger` - manual/auto
- `transcript_path` - Original transcript location
- `backup_path` - Where the backup was saved

## Configuration

### Per-Project Configuration

Create a `.claude-remember.json` file in any project root to configure logging for that project:

```json
{
  "enabled": true,
  "logDir": "/path/to/custom-logs",
  "dbPath": "/path/to/custom-logs/sessions.db",
  "markdown": true,
  "sqlite": true,
  "blockOnFailure": true,
  "maxRetries": 5
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Master switch - set to `false` to disable all logging |
| `logDir` | (global) | Custom directory for this project's markdown logs and backups |
| `dbPath` | (global) | Custom path for this project's SQLite database |
| `markdown` | `true` | Enable markdown file logging |
| `sqlite` | `true` | Enable SQLite database logging |
| `blockOnFailure` | (global) | If `true`, exit non-zero on logging failure (blocks Claude) |
| `maxRetries` | (global) | Number of retry attempts before giving up |
| `retryDelayMs` | (global) | Delay between retries in milliseconds |
| `maxSearchDays` | (global) | Days to search when finding session files |
| `includeToolOutputs` | (global) | Include full tool outputs in markdown |
| `maxToolOutputLength` | (global) | Truncate tool outputs longer than this |
| `debug` | (global) | Enable debug logging to stderr |

Per-project settings override global settings.

**Example configurations:**

```json
// Markdown only (no database)
{"sqlite": false}

// SQLite only (no markdown files)
{"markdown": false}

// Custom location for this project's logs (markdown + SQLite)
{"logDir": "/path/to/project-logs", "dbPath": "/path/to/project-logs/sessions.db"}

// Completely isolated logging (keeps client data separate)
{
  "logDir": "/path/to/client-a/logs",
  "dbPath": "/path/to/client-a/logs/sessions.db"
}

// Disable logging entirely for this project
{"enabled": false}
```

**Commands you can say:**
- `"disable remember logging"` - Creates `.claude-remember.json` with `enabled: false`
- `"retry remember logging"` - Retries any failed logging events (useful if `blockOnFailure` is enabled)

### Global Configuration

Create `~/.claude-logs/config.json` to set defaults for all projects:

```json
{
  "logDir": "~/.claude-logs",
  "includeToolOutputs": true,
  "maxToolOutputLength": 2000,
  "enableWAL": true,
  "excludeTools": ["Read"],
  "excludeProjects": ["/path/to/sensitive-project"],
  "debug": false,
  "blockOnFailure": false,
  "maxRetries": 3,
  "retryDelayMs": 2000,
  "maxSearchDays": 7
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `logDir` | `~/.claude-logs` | Default directory for log files |
| `includeToolOutputs` | `true` | Include full tool outputs in markdown |
| `maxToolOutputLength` | `2000` | Truncate tool outputs longer than this |
| `enableWAL` | `true` | Use SQLite WAL mode for better concurrency |
| `excludeTools` | `[]` | Tools to exclude from logging |
| `excludeProjects` | `[]` | Project paths to exclude from logging |
| `debug` | `false` | Enable debug logging to stderr |
| `blockOnFailure` | `false` | If `true`, exit non-zero on logging failure (blocks Claude) |
| `maxRetries` | `3` | Number of retry attempts before giving up |
| `retryDelayMs` | `2000` | Delay between retries in milliseconds |
| `maxSearchDays` | `7` | Days to search when finding session files |

## Querying the Database

```bash
# Open the database
sqlite3 ~/.claude-logs/sessions.db

# Recent sessions
SELECT id, project_path, started_at, status
FROM sessions
ORDER BY started_at DESC
LIMIT 10;

# Tool usage statistics
SELECT tool_name, COUNT(*) as count,
       ROUND(AVG(CASE WHEN success THEN 100.0 ELSE 0 END), 1) as success_rate
FROM tool_calls
GROUP BY tool_name
ORDER BY count DESC;

# Messages for a specific session
SELECT timestamp, role, substr(content, 1, 100) as preview
FROM messages
WHERE session_id = 'your-session-id'
ORDER BY timestamp;
```

## How It Works

The plugin uses Claude Code's [hooks system](https://code.claude.com/docs/en/hooks) to intercept events:

| Hook Event | What's Logged |
|------------|---------------|
| `SessionStart` | Creates new session record and markdown file |
| `SessionEnd` | Marks session complete, finalizes markdown |
| `UserPromptSubmit` | Logs user messages |
| `PreToolUse` | Logs tool calls with inputs |
| `PostToolUse` | Updates tool call with result/success |
| `Stop` | Captures assistant's response from transcript |

The hooks are designed to be fast (<100ms) and never block Claude Code - errors are logged but don't interrupt your workflow.

## Privacy Considerations

This plugin logs **all conversation content** including:
- Your prompts and questions
- Claude's responses
- File contents read/written
- Command outputs

Consider:
- Using `excludeProjects` for sensitive repositories
- The logs are stored locally - they're never sent anywhere
- Tool outputs may contain sensitive data

## Troubleshooting

### Hooks not firing

1. Check that hooks are in your settings:
   ```bash
   cat ~/.claude/settings.json | grep -A5 "SessionStart"
   ```

2. Verify Bun is in your PATH:
   ```bash
   which bun
   ```

3. Enable debug mode in config and check stderr

### Database locked errors

The plugin uses WAL mode to handle concurrent access. If you still see lock errors:
1. Close any other applications reading the database
2. Run `sqlite3 ~/.claude-logs/sessions.db "PRAGMA wal_checkpoint(TRUNCATE);"`

### Missing sessions

If sessions aren't being logged:
1. Check if the project is in `excludeProjects`
2. Verify the hook handler path is correct in settings
3. Check for errors: `bun run ~/.../src/handler.ts < /dev/null 2>&1`

## Development

```bash
# Run tests
bun test

# Debug mode - see what hooks receive
echo '{"hook_event_name":"SessionStart","session_id":"test","cwd":"/tmp","source":"startup"}' | \
  bun run src/handler.ts
```

## License

MIT
