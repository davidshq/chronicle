---
description: Show all Claude sessions from today (Chronicle)
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/chronicle:*)
---

List all Claude Code sessions captured today (local date):

```
"${CLAUDE_PLUGIN_ROOT}/bin/chronicle" status --today
```

Present the sessions sorted by start time. If none exist for today, say so; the status
output will still show overall capture health.
