## Why

The `exclude_tools` privacy filter drops a tool's *invocation* (`tool_use`) from
the derived markdown and index layers, but the tool's *output* (`tool_result`)
still lands in both. When a user excludes `Bash` for privacy, the command
disappears but its output — often the more sensitive half — is retained. The
filter therefore oversells its privacy contract: it suppresses tool *calls*, not
their results.

## What Changes

- Suppress the `tool_result` of an excluded tool from the derived layers
  (markdown mirror + SQLite/FTS index), matching the treatment its `tool_use`
  already receives. Raw remains untouched (ground truth, never filtered).
- Associate each `tool_result` with the originating `tool_use` by
  `tool_use_id` — the two arrive on **separate transcript lines** (assistant
  message vs. later user message), so the capture engine must carry a small
  cross-line map of excluded tool-use ids within a running daemon.
- Parser change: `jsonl::Entry::ToolUse` and `ToolResult` carry their `id` /
  `tool_use_id` so the engine can join them.
- Document the accepted limitation: the join lives in daemon memory, so a
  daemon restart between a `tool_use` line and its `tool_result` line can let a
  single straggler result through (raw is unaffected; `rebuild` re-filters
  correctly since it replays in order).

## Capabilities

### New Capabilities
- `tool-exclusion`: The `exclude_tools` privacy filter — which transcript
  entries it removes from derived layers, and its guarantee that both the call
  and the result of an excluded tool are suppressed while raw stays lossless.

### Modified Capabilities
<!-- None: no existing spec captured this behavior. -->

## Impact

- `src/jsonl.rs` — `Entry::ToolUse` / `Entry::ToolResult` gain id fields;
  `parse_block` populates them; existing match sites and unit tests update.
- `src/capture/engine.rs` — `feed_derived` filter becomes stateful: records
  excluded `tool_use_id`s and drops matching `tool_result`s. `Engine` gains a
  `HashSet<String>` field.
- `src/layers/markdown.rs` — match arms on the two `Entry` variants update to
  the new field shape (no behavior change there).
- `src/config.rs` — doc comment on `exclude_tools` updated to state that both
  calls and results are suppressed.
- No config-format, storage-layout, or dependency changes.
