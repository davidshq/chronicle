---
description: Search past Claude sessions by keyword (Chronicle FTS)
argument-hint: [query]
allowed-tools: Bash(${CHRONICLE_HOME:-$HOME/.chronicle}/bin/chronicle:*)
---

Search past Claude sessions for: $ARGUMENTS

Run Chronicle's full-text search over the captured store and present the results:

```
"${CHRONICLE_HOME:-$HOME/.chronicle}/bin/chronicle" search "$ARGUMENTS"
```

Each hit shows the role, project, timestamp, and a matching snippet. Summarize the
most relevant matches for the user. The query accepts SQLite FTS5 syntax (e.g. quoted
phrases, `AND`/`OR`, prefixes with `*`). If there are no matches, say so.
