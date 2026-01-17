# Development Guide

This guide covers how to set up, develop, test, and release changes to the Claude Remember plugin.

## Prerequisites

- [Bun](https://bun.sh/) v1.0.0 or later
- Git
- Claude Code CLI (for testing)

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
```

## Getting Started

### Clone and Setup

```bash
git clone https://github.com/davidshq/claude-remember.git
cd claude-remember
bun install
```

### Run in Development Mode

Load the plugin directly from your local directory (no installation needed):

```bash
claude --plugin-dir .
```

This loads your local code instead of any installed version, allowing you to test changes immediately.

### Run Tests

```bash
bun test
```

The test suite covers:
- `db.test.ts` - Database operations, concurrent access
- `markdown.test.ts` - File generation, formatting
- `handler.test.ts` - Event routing, project config
- `transcript.test.ts` - Transcript parsing
- `config.test.ts` - Configuration loading

### Type Check

```bash
bunx tsc --noEmit
```

Always run this before committing to catch type errors.

## Project Structure

```
claude-remember/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest (name, version)
├── hooks/
│   └── hooks.json            # Hook event definitions
├── commands/
│   ├── status.md             # /claude-remember:status
│   ├── search.md             # /claude-remember:search
│   └── today.md              # /claude-remember:today
├── src/
│   ├── handler.ts            # Main entry point
│   ├── db.ts                 # SQLite operations
│   ├── markdown.ts           # Markdown generation
│   ├── transcript.ts         # Transcript parsing
│   ├── config.ts             # Configuration
│   ├── types.ts              # TypeScript interfaces
│   └── __tests__/            # Test files
├── scripts/
│   ├── install.ts            # Legacy installer
│   ├── uninstall.ts          # Legacy uninstaller
│   └── bump-version.ts       # Version management
└── docs/
    ├── ARCHITECTURE.md       # Technical design
    ├── DEVELOPMENT.md        # This file
    └── PLUGIN-BEST-PRACTICES.md
```

## Development Workflow

### Making Changes

1. Create a branch (optional for small fixes):
   ```bash
   git checkout -b feature/my-feature
   ```

2. Make your changes

3. Run tests and type check:
   ```bash
   bun test && bunx tsc --noEmit
   ```

4. Test manually with Claude Code:
   ```bash
   claude --plugin-dir .
   ```

5. Commit with a descriptive message:
   ```bash
   git add .
   git commit -m "Fix: description of what was fixed"
   ```

### Debugging

#### Enable Debug Logging

Create or edit `~/.claude-logs/config.json`:

```json
{
  "debug": true
}
```

Debug output goes to stderr and can be seen in Claude Code's verbose mode.

#### Test Handler Manually

Send mock events directly to the handler:

```bash
# Test SessionStart
echo '{"hook_event_name":"SessionStart","session_id":"test-123","cwd":"/tmp","source":"startup"}' | bun run src/handler.ts

# Test UserPromptSubmit
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test-123","cwd":"/tmp","prompt":"Hello world"}' | bun run src/handler.ts
```

#### Inspect Database

```bash
sqlite3 ~/.claude-logs/sessions.db

# Recent sessions
SELECT id, project_path, started_at, status, markdown_path FROM sessions ORDER BY started_at DESC LIMIT 5;

# Check for issues
SELECT * FROM messages WHERE session_id = 'your-session-id';
```

#### Check Markdown Output

```bash
ls -la ~/.claude-logs/sessions/$(date +%Y-%m-%d)/
cat ~/.claude-logs/sessions/$(date +%Y-%m-%d)/*.md
```

## Version Management

The plugin uses semantic versioning. Both `plugin.json` and `package.json` must stay in sync.

### Bump Version

```bash
# Patch bump: 0.3.3 -> 0.3.4 (bug fixes)
bun run version

# Minor bump: 0.3.3 -> 0.4.0 (new features)
bun run version:minor

# Major bump: 0.3.3 -> 1.0.0 (breaking changes)
bun run version:major
```

This updates both `.claude-plugin/plugin.json` and `package.json` automatically.

### When to Bump Version

- **Always bump** when fixing bugs that affect users
- **Always bump** when adding new features
- **Don't bump** for documentation-only changes, test changes, or internal refactoring that doesn't affect behavior

**Important:** Claude Code caches plugins by version. If you push a fix without bumping the version, users who run `plugin marketplace update` may not get the new code.

## Release Process

1. Ensure all tests pass:
   ```bash
   bun test && bunx tsc --noEmit
   ```

2. Bump the version:
   ```bash
   bun run version  # or version:minor / version:major
   ```

3. Commit and push:
   ```bash
   git add .claude-plugin/plugin.json package.json
   git commit -m "Release v0.3.4"
   git push origin main
   ```

4. Users update with:
   ```bash
   claude plugin marketplace update claude-remember
   ```

## Common Issues

### Plugin Changes Not Taking Effect

When testing locally with `--plugin-dir`, changes should take effect immediately. If not:

1. Check for syntax errors: `bunx tsc --noEmit`
2. Verify you're in the right directory
3. Restart Claude Code

### Installed Plugin Not Updating

If users report the update command doesn't work:

1. Check if the version was bumped in `plugin.json`
2. Verify the commit was pushed to `main`
3. Check the installed version:
   ```bash
   cat ~/.claude/plugins/installed_plugins.json | grep claude-remember
   ```

### Database Locked Errors

The plugin uses WAL mode for concurrent access. If you see lock errors during development:

```bash
# Force checkpoint
sqlite3 ~/.claude-logs/sessions.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### Cross-Process State Issues

Each hook invocation runs as a separate Bun process. The in-memory `activeSessions` map is empty each time. Session recovery works via:

1. Database lookup (`markdown_path` column)
2. File search by session ID in filename
3. Creating new session if not found

If markdown files aren't being written to:
- Check that `markdown_path` is being saved to the correct database (custom `dbPath` if configured)
- Check that file searches use the correct directory (custom `logDir` if configured)

## Code Conventions

### Error Handling

- Always exit 0 from the handler (never block Claude Code)
- Log errors to stderr
- Use the retry mechanism for transient failures

### Database Operations

- Always accept optional `dbPath` parameter for per-project databases
- Use prepared statements
- Close connections in finally blocks

### Markdown Operations

- Always accept optional `customLogDir` and `customDbPath` for per-project configs
- Thread these parameters through all functions that need them

### Testing

- Each test file cleans up after itself
- Use unique session IDs to avoid conflicts
- Test both success and error paths

## Architecture Overview

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed technical documentation covering:

- System overview and data flow
- Component responsibilities
- Database schema
- Design decisions

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Ensure `bun test` and `bunx tsc --noEmit` pass
5. Submit a pull request

For bug reports and feature requests, open an issue on GitHub.
