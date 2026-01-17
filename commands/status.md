---
description: Show claude-remember logging status and recent sessions
---

Check the claude-remember session logging status:

1. Read the configuration from ~/.claude-logs/config.json (if it exists) to show current settings
2. List the 5 most recent session markdown files from ~/.claude-logs/sessions/ (check today's date folder first)
3. Query the SQLite database at ~/.claude-logs/sessions.db to count total sessions and messages
4. Report any per-project overrides from .claude-remember.json in the current directory

Display a summary showing:
- Whether logging is enabled
- Log directory location
- Database location and stats (total sessions, messages, tool calls)
- Recent session files with their timestamps and projects
