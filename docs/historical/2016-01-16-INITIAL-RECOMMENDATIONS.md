# Claude Code Session Logger Plugin - Research & Recommendations

## Executive Summary

This document presents research findings and recommendations for building a Claude Code plugin that intercepts all logs and saves them:
1. As individual markdown files divided by session
2. Into a SQLite database

**Key Finding**: No existing plugin provides this exact dual-output functionality. Several tools offer partial solutions, but none combine real-time log interception with both markdown export and SQLite persistence in a single integrated plugin.

---

## Research Findings

### Existing Solutions Analysis

| Tool | Markdown Export | SQLite Storage | Real-time | Gaps |
|------|-----------------|----------------|-----------|------|
| [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | ✗ | ✓ | ✓ | No markdown, focuses on monitoring UI |
| [@mariozechner/claude-trace](https://www.npmjs.com/package/@mariozechner/claude-trace) | ✗ (HTML only) | ✗ | ✓ | No SQLite, HTML-only output |
| [claude-conversation-extractor](https://pypi.org/project/claude-conversation-extractor/) | ✓ | ✗ | ✗ | Post-hoc only, no SQLite |
| [Claudex](https://github.com/hesreallyhim/awesome-claude-code) | ✓ (multiple formats) | ✗ | ✗ | Browser-based, not a hook plugin |
| [@constellos/claude-code-kit](https://www.npmjs.com/package/@constellos/claude-code-kit) | ✗ | ✗ | ✓ | Library only, no persistence |

**Conclusion**: There is a clear gap for a plugin that provides dual-format persistence (markdown + SQLite) with real-time hook integration.

### Claude Code Hooks System

Claude Code provides **10 hook events** for intercepting agent behavior:

| Hook Event | When It Fires | Use for Logging |
|------------|---------------|-----------------|
| `SessionStart` | Session begins/resumes | ✓ Initialize log files, create session record |
| `SessionEnd` | Session terminates | ✓ Finalize markdown, update session status |
| `UserPromptSubmit` | User sends a prompt | ✓ Log user messages |
| `PreToolUse` | Before tool execution | ✓ Log tool calls |
| `PostToolUse` | After tool completes | ✓ Log tool results |
| `Stop` | Main agent finishes response | ✓ Log assistant responses |
| `SubagentStop` | Subagent completes | ✓ Log subagent activity |
| `Notification` | Notifications sent | Optional |
| `PermissionRequest` | Permission dialog shown | Optional |
| `PreCompact` | Before context compaction | Optional |

### Key Data Available to Hooks

Every hook receives via stdin:
```json
{
  "session_id": "unique-session-identifier",
  "transcript_path": "/path/to/.claude/projects/.../session.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "EventName"
}
```

The `transcript_path` points to the full conversation JSONL file, which can be parsed for complete conversation history.

---

## Recommended Architecture

### Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Claude Code                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Hook Events (stdin JSON)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Hook Handler (TypeScript/Bun)                │
│  • Receives hook events                                         │
│  • Parses transcript when needed                                │
│  • Formats data for storage                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   Markdown Writer       │     │   SQLite Writer         │
│  • Session-based files  │     │  • Structured storage   │
│  • Human-readable       │     │  • Queryable data       │
│  • Git-friendly         │     │  • Analytics-ready      │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  ~/.claude-logs/        │     │  ~/.claude-logs/        │
│  └── sessions/          │     │  └── sessions.db        │
│      └── 2026-01-16/    │     │                         │
│          └── abc123.md  │     │                         │
└─────────────────────────┘     └─────────────────────────┘
```

### Technology Stack Recommendation

| Component | Recommendation | Rationale |
|-----------|----------------|-----------|
| **Runtime** | Bun | Fast startup, native TypeScript, built-in SQLite |
| **Language** | TypeScript | Type safety, good tooling, works with Bun |
| **SQLite Library** | `bun:sqlite` (built-in) | Zero dependencies, fast, native |
| **Markdown Generation** | Custom formatter | Simple requirements, no library needed |
| **Package Manager** | Bun | Consistent with runtime |

**Alternative**: Python with `uv` (single-file scripts with embedded dependencies) - simpler but slower startup.

### SQLite Schema Design

```sql
-- Sessions table
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT DEFAULT 'active',  -- active, completed, interrupted
    summary TEXT,
    token_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0
);

-- Messages table
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    timestamp TEXT NOT NULL,
    role TEXT NOT NULL,  -- user, assistant, system, tool
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_input TEXT,     -- JSON
    tool_output TEXT,    -- JSON
    tokens_used INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Tool calls table (for analytics)
CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id INTEGER REFERENCES messages(id),
    timestamp TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_summary TEXT,
    success INTEGER,
    duration_ms INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Indexes for common queries
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX idx_sessions_date ON sessions(started_at);
```

### Markdown File Structure

```
~/.claude-logs/
├── sessions.db                    # SQLite database
├── sessions/
│   ├── 2026-01-16/
│   │   ├── abc123_project-name.md
│   │   └── def456_other-project.md
│   └── 2026-01-17/
│       └── ghi789_project-name.md
└── index.md                       # Auto-generated session index
```

**Markdown Format**:
```markdown
# Session: abc123
**Project**: /path/to/project
**Started**: 2026-01-16 10:30:00 UTC
**Status**: Completed

---

## User (10:30:05)
Help me fix the authentication bug

---

## Assistant (10:30:15)
I'll help you fix the authentication bug. Let me first examine the code.

### Tool: Read
**File**: `/src/auth.ts`

---

## Assistant (10:30:20)
I found the issue...

[continues...]
```

### Hook Configuration

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "bun run ~/.claude-plugins/session-logger/handler.ts SessionStart"
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "bun run ~/.claude-plugins/session-logger/handler.ts SessionEnd"
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "bun run ~/.claude-plugins/session-logger/handler.ts UserPromptSubmit"
      }]
    }],
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "bun run ~/.claude-plugins/session-logger/handler.ts PreToolUse"
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "bun run ~/.claude-plugins/session-logger/handler.ts PostToolUse"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "bun run ~/.claude-plugins/session-logger/handler.ts Stop"
      }]
    }]
  }
}
```

---

## Implementation Recommendations

### 1. Plugin Structure

```
~/.claude-plugins/session-logger/
├── package.json
├── handler.ts           # Main entry point (receives hook events)
├── src/
│   ├── db.ts            # SQLite operations
│   ├── markdown.ts      # Markdown file generation
│   ├── transcript.ts    # JSONL transcript parser
│   ├── types.ts         # TypeScript interfaces
│   └── config.ts        # Configuration management
├── tests/
│   └── *.test.ts
└── README.md
```

### 2. Key Implementation Details

**Fast Startup**: Hooks must be fast. Use Bun for sub-100ms cold starts.

**Atomic Writes**: Use WAL mode for SQLite and temp files with rename for markdown to prevent corruption.

**Transcript Parsing**: The `transcript_path` contains the full conversation. Parse it on `Stop` events to capture complete assistant responses.

**Deduplication**: Track processed message IDs to avoid duplicates when parsing transcripts.

**Error Handling**: Hooks should never fail the main Claude session. Catch all errors and log them separately.

### 3. Configuration Options

```typescript
interface Config {
  // Storage paths
  logDir: string;           // Default: ~/.claude-logs
  dbPath: string;           // Default: ~/.claude-logs/sessions.db

  // Markdown options
  includeToolOutputs: boolean;  // Include full tool outputs in markdown
  maxToolOutputLength: number;  // Truncate long outputs (default: 1000)

  // SQLite options
  enableWAL: boolean;       // Use WAL mode (default: true)

  // Filtering
  excludeTools: string[];   // Tools to exclude from logging
  excludeProjects: string[]; // Project paths to exclude
}
```

### 4. Considerations

**Privacy**: The plugin will log all conversation content. Consider:
- Adding an option to exclude sensitive projects
- Not logging `.env` file contents or credentials
- Respecting `.gitignore` patterns for tool outputs

**Performance**:
- Keep hooks under 100ms
- Use async writes where possible
- Batch SQLite inserts if needed

**Storage**:
- Implement log rotation/cleanup
- Compress old markdown files
- Consider SQLite VACUUM scheduling

---

## Alternative Approaches Considered

### 1. Post-hoc Processing Only
**Approach**: Don't use hooks. Parse `~/.claude/projects/` JSONL files periodically.
**Pros**: Simpler, no hook overhead
**Cons**: Not real-time, may miss data before cleanup

### 2. External Server Architecture
**Approach**: Hooks POST to a local server (like `claude-code-hooks-multi-agent-observability`)
**Pros**: Decoupled, can add web UI
**Cons**: More complex, requires running server

### 3. Pure Shell Script
**Approach**: Use bash scripts instead of TypeScript
**Pros**: No dependencies
**Cons**: Harder to maintain, no good SQLite integration

**Recommendation**: The proposed TypeScript/Bun approach offers the best balance of performance, maintainability, and features.

---

## Next Steps

1. **Create plugin directory structure**
2. **Implement core handler with event routing**
3. **Build SQLite storage layer**
4. **Build markdown writer**
5. **Add transcript parser for complete messages**
6. **Write tests**
7. **Create installation script**
8. **Document configuration options**

---

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [@constellos/claude-code-kit](https://www.npmjs.com/package/@constellos/claude-code-kit)
- [@mariozechner/claude-trace](https://www.npmjs.com/package/@mariozechner/claude-trace)
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
- [Claude Code Session Management](https://deepwiki.com/anthropics-claude/claude-code/2.3-session-management)
