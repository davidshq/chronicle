# Best Practices for Writing Claude Code Plugins

A comprehensive guide to developing high-quality, secure, and performant Claude Code plugins.

**Last updated:** January 2026

## Table of Contents

1. [Introduction](#introduction)
2. [Plugin Structure](#plugin-structure)
3. [Manifest Configuration](#manifest-configuration)
4. [Slash Commands](#slash-commands)
5. [Hooks](#hooks)
6. [Agent Skills](#agent-skills)
7. [MCP Server Integration](#mcp-server-integration)
8. [Performance Best Practices](#performance-best-practices)
9. [Security Best Practices](#security-best-practices)
10. [Testing & Debugging](#testing--debugging)
11. [Distribution & Sharing](#distribution--sharing)
12. [Common Pitfalls](#common-pitfalls)
13. [Resources](#resources)

---

## Introduction

Claude Code plugins extend the CLI with custom functionality including slash commands, specialized agents, hooks, and MCP server integrations. They can be shared across projects and teams via marketplaces.

**When to use plugins vs standalone configuration:**

| Approach | Command Names | Best For |
|----------|---------------|----------|
| **Standalone** (`.claude/` directory) | `/hello` | Personal workflows, project-specific customizations |
| **Plugins** (`.claude-plugin/plugin.json`) | `/plugin-name:hello` | Team sharing, community distribution, versioned releases |

Source: [Claude Code Plugin Documentation](https://code.claude.com/docs/en/plugins)

---

## Plugin Structure

Every plugin follows this standard directory structure:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Required manifest (ONLY this file goes here)
├── commands/                # Slash commands (optional)
│   └── hello.md
├── agents/                  # Custom agents (optional)
├── skills/                  # Agent Skills (optional)
│   └── code-review/
│       └── SKILL.md
├── hooks/                   # Event handlers (optional)
│   └── hooks.json
├── .mcp.json               # MCP servers (optional)
├── .lsp.json               # LSP servers (optional)
└── README.md               # Documentation (recommended)
```

**Critical:** Only `plugin.json` goes in `.claude-plugin/`. All other directories must be at the plugin root level—this is a [common mistake](https://code.claude.com/docs/en/plugins) that causes plugins to fail silently.

Source: [GitHub - anthropics/claude-code plugins README](https://github.com/anthropics/claude-code/blob/main/plugins/README.md)

---

## Manifest Configuration

The manifest at `.claude-plugin/plugin.json` defines your plugin's identity:

```json
{
  "name": "my-plugin",
  "description": "A clear, concise description of what the plugin does",
  "version": "1.0.0",
  "author": {
    "name": "Your Name"
  },
  "homepage": "https://github.com/user/my-plugin",
  "repository": "https://github.com/user/my-plugin",
  "license": "MIT"
}
```

### Required vs Optional Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | **Yes** | Unique identifier (kebab-case, no spaces) |
| `version` | No | Semantic version (recommended) |
| `description` | No | Brief explanation (recommended) |
| `author` | No | Author name, email, URL |
| `homepage` | No | Documentation URL |
| `repository` | No | Source code URL |
| `license` | No | License identifier (MIT, Apache-2.0, etc.) |
| `keywords` | No | Array of tags for discovery |

### Best Practices

1. **Choose a unique, descriptive name** — The name becomes your slash command namespace (`/my-plugin:command`)
2. **Use semantic versioning** — Follow [semver](https://semver.org/) (MAJOR.MINOR.PATCH) for releases
3. **Write a clear description** — This is shown in the plugin manager and helps users understand your plugin
4. **Include repository/homepage** — Enables users to report issues and contribute

Source: [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)

---

## Slash Commands

Slash commands are Markdown files in the `commands/` directory. The filename becomes the command name.

### Basic Command

**File:** `commands/hello.md`

```markdown
---
description: Greet the user with a friendly message
---

# Hello Command

Greet the user warmly and ask how you can help them today.
```

**Usage:** `/my-plugin:hello`

### Command with Arguments

```markdown
---
description: Greet the user with a personalized message
---

# Hello Command

Greet the user named "$ARGUMENTS" warmly. Make the greeting personal.
```

**Argument variables:**
- `$ARGUMENTS` — All text after the slash command
- `$1`, `$2`, etc. — Individual space-separated parameters

### Available Frontmatter Fields

| Field | Description |
|-------|-------------|
| `description` | Shows in `/help` output; helps users discover commands |
| `allowed-tools` | Tools permitted without prompting (e.g., `Read, Grep, Bash(git status:*)`) |
| `argument-hint` | Hint about expected arguments (e.g., `[issue-number]`) |
| `model` | Force specific model (e.g., `claude-3-5-sonnet-20240620`) |
| `disable-model-invocation` | Prevent programmatic invocation via Skill tool |

**Example with multiple fields:**

```markdown
---
description: Create a git commit with the specified message
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
argument-hint: [message]
model: claude-3-5-haiku-20241022
---

# Commit Command

Create a git commit with the message "$ARGUMENTS".
```

Source: [Claude Code Slash Commands](https://code.claude.com/docs/en/slash-commands)

### Best Practices

1. **Always include a description** in the frontmatter — helps users discover your commands
2. **Keep prompts focused** — One clear purpose per command
3. **Use subdirectories for organization** — `commands/git/commit.md` creates `/plugin:git/commit`
4. **Test with various argument patterns** — Edge cases like empty args, special characters
5. **Consider argument validation** — Document expected argument format in the description

### LLM-Interpreted vs Deterministic Commands

Claude Code supports two command styles:

| Type | How It Works | Best For |
|------|--------------|----------|
| **LLM-interpreted** | Claude reads the prompt and decides what to do | Flexible, context-aware tasks |
| **Deterministic** | Hook intercepts and runs exact code | Consistent, repeatable actions |

For deterministic commands, intercept the prompt in a `UserPromptSubmit` hook and execute specific logic. This plugin uses both approaches—see the [handler.ts](../src/handler.ts) for deterministic command detection.

Source: [Claude Code Slash Commands](https://code.claude.com/docs/en/plugins)

---

## Hooks

Hooks are automated scripts that execute at specific events during Claude Code sessions.

### Hook Configuration

**File:** `hooks/hooks.json`

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Available Hook Events

| Event | When It Runs | Common Use Cases |
|-------|--------------|------------------|
| `SessionStart` | Session startup or resume | Load context, set environment |
| `SessionEnd` | Session ends | Cleanup, logging |
| `UserPromptSubmit` | User submits a prompt | Validation, context injection |
| `PreToolUse` | Before tool executes | Permission control, input modification |
| `PostToolUse` | After tool completes successfully | Auto-formatting, logging |
| `PostToolUseFailure` | After tool execution fails | Error handling, retry logic |
| `Stop` | Claude finishes responding | Verification, continuation logic |
| `SubagentStart` | Subagent is started | Subagent initialization |
| `SubagentStop` | Subagent completes | Subagent result handling |
| `Notification` | Claude sends notifications | Custom notification handling |
| `PermissionRequest` | Permission dialog shown | Auto-approve/deny logic |
| `PreCompact` | Before context compaction | Backup transcripts |

### Matcher Patterns

- Simple string: `Write` (exact match, case-sensitive)
- Regex pattern: `Write|Edit` or `Notebook.*`
- Match all: `*` or `""`
- MCP tools: `mcp__memory__.*` or `mcp__.*__write.*`

### Hook Types

**Command hooks** (`type: "command"`) — Execute shell scripts:

```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/scripts/validate.py",
  "timeout": 60
}
```

**Prompt hooks** (`type: "prompt"`) — Use LLM for complex decisions:

```json
{
  "type": "prompt",
  "prompt": "Evaluate if all tasks are complete. Respond with JSON.",
  "timeout": 30
}
```

**Agent hooks** (`type: "agent"`) — Run agentic verifiers with tools for complex verification:

```json
{
  "type": "agent",
  "prompt": "Verify this code change follows our security guidelines."
}
```

### Environment Variables

Available in hook scripts:

| Variable | Description |
|----------|-------------|
| `CLAUDE_PLUGIN_ROOT` | Absolute path to plugin directory (use this in plugins) |
| `CLAUDE_PROJECT_DIR` | Project root directory (may be empty in plugin hooks—see note) |
| `CLAUDE_ENV_FILE` | (SessionStart only) File for persisting env vars |
| `CLAUDE_CODE_REMOTE` | `"true"` if running in web environment |

**Note:** There is a [known issue](https://github.com/anthropics/claude-code/issues/9447) where `CLAUDE_PROJECT_DIR` may be empty in plugin `hooks.json` files. Always use `CLAUDE_PLUGIN_ROOT` for plugin-relative paths. For project-relative paths in plugins, consider passing the path via hook input JSON instead.

### Hook Input/Output

Hooks receive JSON via stdin and communicate via exit codes and stdout:

**Exit codes:**
- `0` — Success (stdout shown in verbose mode)
- `2` — Blocking error (stderr feeds back to Claude)
- Other — Non-blocking error (stderr shown in verbose mode)

**JSON output for PreToolUse:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Safe operation",
    "updatedInput": { "field": "new value" },
    "additionalContext": "Context for Claude"
  }
}
```

### Best Practices

1. **Keep hooks fast** — Target <100ms for optimal UX; use `timeout` to prevent hangs
2. **Exit 0 by default** — Hooks should fail-open to avoid blocking workflow
3. **Quote all shell variables** — Always use `"$VAR"` not `$VAR`
4. **Use absolute paths** — Reference `"$CLAUDE_PROJECT_DIR"` or `"$CLAUDE_PLUGIN_ROOT"`
5. **Handle missing fields gracefully** — Not all events include all fields
6. **Log errors to stderr** — Stdout is often parsed as JSON or context
7. **Test thoroughly before deployment** — Use `claude --debug` to see hook execution

Source: [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)

---

## Agent Skills

Skills are model-invoked capabilities that Claude automatically uses based on context.

### Creating a Skill

**File:** `skills/code-review/SKILL.md`

```markdown
---
name: code-review
description: Reviews code for best practices and potential issues.
  Use when reviewing code, checking PRs, or analyzing code quality.
---

When reviewing code, check for:
1. Code organization and structure
2. Error handling
3. Security concerns
4. Performance implications
5. Test coverage
```

### Required Frontmatter Fields

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | **Yes** | Max 64 chars, lowercase letters/numbers/hyphens only |
| `description` | **Yes** | Max 1024 chars, non-empty |

**Naming convention:** Use gerund form (verb + -ing) for skill names (e.g., `code-reviewing`, `testing-api`).

### Best Practices

1. **Write clear trigger descriptions** — Claude uses the description to decide when to invoke the skill
2. **Put "when to use" info in the description** — The body is only loaded after triggering, so trigger conditions must be in the description
3. **Be specific about use cases** — "Use when..." helps Claude understand context
4. **Keep content focused** — Skills should be deep on one topic, not broad
5. **Use markdown formatting** — Lists, headers, and code blocks improve readability

Source: [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills), [Claude Help Center - Custom Skills](https://support.claude.com/en/articles/12512198-how-to-create-custom-skills)

### Component-Scoped Hooks

Skills can define their own hooks in frontmatter:

```yaml
---
name: secure-operations
description: Perform operations with security checks
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/security-check.sh"
          once: true  # Run only once per session
---
```

Supported events: `PreToolUse`, `PostToolUse`, `Stop`

Source: [Claude Code Skills Documentation](https://code.claude.com/docs/en/plugins)

---

## MCP Server Integration

MCP (Model Context Protocol) servers extend Claude Code with external tool access.

### Configuration

**File:** `.mcp.json`

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-memory"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/allowed/path"]
    }
  }
}
```

### Best Practices

1. **Document required servers** — Include setup instructions in README
2. **Use explicit server names** — Helps users understand what's being enabled
3. **Consider security implications** — MCP servers have broad access
4. **Provide fallbacks** — Plugin should work (with reduced functionality) if server unavailable

### Security Warning

Users must explicitly enable MCP servers. Never assume automatic trust:

```json
// DANGEROUS - enables all discovered servers
{ "enableAllProjectMcpServers": true }

// SAFE - explicit allowlist
{ "enabledMcpjsonServers": ["memory", "filesystem"] }
```

Source: [Backslash Security - Claude Code Best Practices](https://www.backslash.security/blog/claude-code-security-best-practices)

---

## Performance Best Practices

### Hook Performance

1. **Minimize startup time** — Use compiled languages or fast runtimes (Bun starts in <100ms vs Node's ~300ms)
2. **Avoid blocking I/O** — Use async operations where possible
3. **Cache connections** — Reuse database/network connections across hook invocations
4. **Set appropriate timeouts** — Default is 60 seconds; reduce for simple checks

### Context Management

1. **Create a CLAUDE.md** — Document your plugin's conventions and commands
2. **Keep prompts focused** — One objective per command
3. **Use `/clear` between unrelated tasks** — Prevents context pollution
4. **Batch similar operations** — Process multiple items in one session

### Database Operations (for logging/state plugins)

1. **Use WAL mode** — Better concurrency for SQLite
2. **Set busy_timeout** — Prevents immediate failures on lock contention
3. **Close connections in finally blocks** — Prevents resource leaks
4. **Consider per-project isolation** — Separate databases for different projects

Source: [Anthropic Engineering - Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)

---

## Security Best Practices

### Permission Management

**Allowlist approach (recommended):**

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run test:*)",
      "Read(**/*.md)"
    ],
    "ask": [
      "Bash(git push:*)",
      "Write(**/*.ts)"
    ],
    "deny": [
      "Bash(curl:*)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/secrets/**)"
    ]
  }
}
```

**Syntax notes:**
- Bash commands: `Bash(exact command)` or `Bash(prefix:*)` for wildcards
- File paths: Use gitignore-like patterns (`**/.env`, `**/node_modules/**`)
- Deny rules always override allow rules

1. **Start with minimal permissions** — Only allow what's necessary
2. **Use ask for risky operations** — Ensure human review
3. **Deny dangerous patterns** — Block access to secrets, credentials, sensitive paths

Source: [Claude Code Settings](https://code.claude.com/docs/en/settings)

### Hook Security

1. **Validate all inputs** — Never trust stdin JSON blindly
2. **Block path traversal** — Check for `..` in file paths
3. **Skip sensitive files** — Avoid `.env`, `.git/`, SSH keys, credentials
4. **Use `set -euo pipefail`** — Fail fast on errors in bash scripts
5. **Sanitize shell arguments** — Prevent command injection

**Example validation:**

```python
#!/usr/bin/env python3
import json
import sys
import os

input_data = json.load(sys.stdin)
file_path = input_data.get("tool_input", {}).get("file_path", "")

# Block path traversal
if ".." in file_path:
    print("Path traversal blocked", file=sys.stderr)
    sys.exit(2)

# Skip sensitive files
sensitive = [".env", ".ssh", "credentials", "secrets"]
if any(s in file_path.lower() for s in sensitive):
    print("Sensitive file blocked", file=sys.stderr)
    sys.exit(2)

sys.exit(0)
```

### Sandboxing

For high-security environments:

1. **Use `/sandbox`** — Enable Claude Code's built-in sandboxing
2. **Run in containers** — Docker/Podman for OS-level isolation
3. **Never run as root** — AI should never have admin privileges
4. **Restrict network access** — Use proxy servers or firewall rules

Source: [Anthropic Engineering - Claude Code Sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)

### MCP Server Security

1. **Never enable all servers automatically** — Use explicit allowlists
2. **Understand what each server does** — Review before enabling
3. **Block risky servers** — Use `disabledMcpjsonServers` for known-dangerous servers

Source: [Claude Code Security Documentation](https://code.claude.com/docs/en/security)

---

## Testing & Debugging

### Local Testing

```bash
# Load plugin without installation
claude --plugin-dir ./my-plugin

# Load multiple plugins
claude --plugin-dir ./plugin-one --plugin-dir ./plugin-two

# Enable debug output
claude --debug
```

### Test Checklist

- [ ] Commands appear with `/` autocomplete
- [ ] Commands execute correctly with various arguments
- [ ] Hooks trigger at expected events
- [ ] Skills appear in `/agents` or are auto-invoked appropriately
- [ ] MCP servers connect (if applicable)
- [ ] Error cases handled gracefully

### Debugging Hooks

1. **Use `claude --debug`** — Shows detailed hook execution logs
2. **Add logging** — Write to temp files or stderr for inspection
3. **Test scripts independently** — Run hook scripts manually with test JSON

```bash
# Test a hook script manually
echo '{"tool_name":"Write","tool_input":{"file_path":"test.txt"}}' | ./hooks/validate.py
```

### Debug Output Example

```
[DEBUG] Executing hooks for PostToolUse:Write
[DEBUG] Found 1 hook matchers in settings
[DEBUG] Matched 1 hooks for query "Write"
[DEBUG] Executing hook command with timeout 60000ms
[DEBUG] Hook command completed with status 0
```

### Common Debugging Issues

| Issue | Solution |
|-------|----------|
| Plugin not loading | Check `.claude-plugin/plugin.json` exists and is valid JSON |
| Commands not appearing | Verify `commands/` is at plugin root, not in `.claude-plugin/` |
| Hooks not triggering | Check `hooks.json` format; verify matcher pattern matches; check event name case |
| Scripts failing | Ensure shebang (`#!/bin/bash`), executable permission (`chmod +x`) |
| Path errors | Use `${CLAUDE_PLUGIN_ROOT}` for plugin-relative paths |
| Empty `CLAUDE_PROJECT_DIR` | Known bug in plugin hooks; use `CLAUDE_PLUGIN_ROOT` or get path from stdin JSON |

Source: [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)

---

## Distribution & Sharing

### Pre-Distribution Checklist

1. **Include comprehensive README.md** — Installation, usage, configuration
2. **Use semantic versioning** — Update `version` in plugin.json
3. **Test with fresh installation** — Ensure no local dependencies
4. **Document all commands and hooks** — Help users understand capabilities
5. **Include license** — Standard open-source license (MIT, Apache 2.0, etc.)

### Distribution Options

1. **Official marketplace** — Submit via [plugin directory form](https://clau.de/plugin-directory-submission)
2. **GitHub releases** — Version-tagged releases for manual installation
3. **Team repositories** — Private distribution within organizations

### Installation Scopes

Plugins can be installed to different scopes:

| Scope | Settings File | Use Case |
|-------|---------------|----------|
| `user` | `~/.claude/settings.json` | Personal plugins (default) |
| `project` | `.claude/settings.json` | Team plugins via version control |
| `local` | `.claude/settings.local.json` | Project-specific, gitignored |
| `managed` | `managed-settings.json` | Enterprise-managed plugins (read-only) |

### Quality Requirements for Official Directory

From [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official):

- Must meet quality and security standards
- Subject to security review before inclusion
- Include comprehensive documentation
- Follow standard plugin structure

### Security Notice for Users

Plugins can include arbitrary code. Users should:

- Review plugin source before installation
- Understand what MCP servers are included
- Trust the plugin author/organization

Source: [GitHub - anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)

---

## Common Pitfalls

### Structure Issues

| Mistake | Fix |
|---------|-----|
| Putting `commands/` inside `.claude-plugin/` | Move to plugin root |
| Missing `plugin.json` | Create `.claude-plugin/plugin.json` |
| Invalid JSON in manifest | Validate with `jq` or JSON linter |

### Hook Issues

| Mistake | Fix |
|---------|-----|
| Exit code 1 for blocking errors | Use exit code 2 |
| Unquoted shell variables | Always use `"$VAR"` |
| Relative paths in commands | Use `${CLAUDE_PLUGIN_ROOT}` |
| Missing executable permission | Run `chmod +x script.sh` |
| No shebang line | Add `#!/bin/bash` or `#!/usr/bin/env python3` |
| Wrong event name case | Event names are case-sensitive (`PostToolUse`, not `postToolUse`) |
| Using `CLAUDE_PROJECT_DIR` in plugins | May be empty; use `CLAUDE_PLUGIN_ROOT` instead |

### Command Issues

| Mistake | Fix |
|---------|-----|
| Missing frontmatter description | Add `---\ndescription: ...\n---` |
| Unclear argument handling | Document expected `$ARGUMENTS` format |
| Overly complex prompts | Split into multiple focused commands |

### Performance Issues

| Mistake | Fix |
|---------|-----|
| Heavy startup in hooks | Move initialization outside hot path |
| No timeout configuration | Add `"timeout": 30` for quick checks |
| Blocking database calls | Use WAL mode, set busy_timeout |

---

## Resources

### Official Documentation

- [Claude Code Plugin Documentation](https://code.claude.com/docs/en/plugins) — Primary plugin development guide
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — Complete hooks API reference
- [Claude Code Security](https://code.claude.com/docs/en/security) — Security model and recommendations
- [GitHub - anthropics/claude-code](https://github.com/anthropics/claude-code) — Official Claude Code repository

### Official Plugins & Examples

- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) — Official Anthropic plugin directory
- [Example plugins](https://github.com/anthropics/claude-code/tree/main/plugins) — Reference implementations

### Community Resources

- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — Curated list of skills, hooks, commands, and plugins
- [awesome-claude-code-plugins](https://github.com/ccplugins/awesome-claude-code-plugins) — Plugin-focused resource list
- [ChrisWiles/claude-code-showcase](https://github.com/ChrisWiles/claude-code-showcase) — Comprehensive project configuration example

### Articles & Guides

- [Anthropic Engineering - Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices) — Official best practices
- [Anthropic Engineering - Claude Code Sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) — Security and sandboxing guide
- [Backslash Security - Claude Code Security Best Practices](https://www.backslash.security/blog/claude-code-security-best-practices) — Security-focused recommendations
- [Builder.io - How I Use Claude Code](https://www.builder.io/blog/claude-code) — Practical usage tips
- [eesel.ai - Complete Guide to Hooks](https://www.eesel.ai/blog/hooks-in-claude-code) — Hooks deep dive

### Tools

- [Shipyard - Claude Code Cheatsheet](https://shipyard.build/blog/claude-code-cheat-sheet/) — Quick reference guide
- [ClaudeLog](https://claudelog.com/) — Docs, guides, and tutorials

---

## About This Guide

This guide was compiled from official Anthropic documentation, community resources, and practical experience developing Claude Code plugins.

Contributions and corrections welcome via pull request.
