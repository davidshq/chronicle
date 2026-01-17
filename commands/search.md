---
description: Search past Claude sessions by keyword
argument-hint: [query]
allowed-tools: Read, Bash(sqlite3:*), Grep
---

Search past Claude sessions for: $ARGUMENTS

Query the SQLite database at ~/.claude-logs/sessions.db to find sessions and messages containing the search term.

Search in:
1. User prompts (messages table where role='user')
2. Assistant responses (messages table where role='assistant')
3. Tool inputs and outputs (tool_calls table)

For each match, show:
- Session date and project
- The matching content with context
- Link to the full markdown file

Limit results to 10 most recent matches. If no database exists, search the markdown files in ~/.claude-logs/sessions/ instead using grep.
