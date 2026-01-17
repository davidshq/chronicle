---
description: Show all Claude sessions from today
allowed-tools: Read, Bash(sqlite3:*), Glob
---

List all Claude Code sessions from today.

1. Determine today's date in YYYY-MM-DD format (local timezone)
2. List all markdown files in ~/.claude-logs/sessions/YYYY-MM-DD/
3. For each session file, extract:
   - Session start time (from filename)
   - Project name (from filename)
   - Session status (Active/Complete - check the markdown content)
   - Number of user prompts
   - Brief summary of topics discussed (first user prompt)

Display as a table sorted by start time, most recent first.

If no sessions exist for today, say so and show the most recent day that has sessions.
