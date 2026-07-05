---
description: Show Chronicle capture health and recent sessions
allowed-tools: Bash($HOME/.chronicle/bin/chronicle:*)
---

Run the Chronicle status command and present its output to the user:

```
"$HOME/.chronicle/bin/chronicle" status
```

This reports:
- Capture health (via the watchdog): whether the `chronicle` daemon is running and the store is fresh
- Recent sessions with timestamps, project, and message counts

If it reports the recorder is not running or stale, remind the user to start the daemon (`chronicle daemon`, or via the installed service) and point them at the install script if needed.
