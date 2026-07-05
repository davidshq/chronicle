## Context

`exclude_tools` is a privacy filter: it removes a named tool's activity from the
derived layers while leaving raw untouched. Today the filter is a single
stateless `retain` in `capture::Engine::feed_derived`
(`src/capture/engine.rs:145`) that drops `Entry::ToolUse` whose name is
excluded. It has a blind spot: a tool's output is a separate
`Entry::ToolResult` that carries no tool name, so the result survives into
markdown and the index even when the call is dropped.

The structural obstacle is that a `tool_use` and its `tool_result` do **not**
share a transcript line. In Claude Code transcripts the `tool_use` block lives
in an assistant message (one JSONL line) and the matching `tool_result` block
lives in a *later* user message (a subsequent line). They are linked only by
id: the `tool_use` block has an `id`, the `tool_result` block has a
`tool_use_id`. `feed_derived` is invoked once per line and holds no memory of
prior lines, so the join must be carried in engine state.

## Goals / Non-Goals

**Goals:**
- Suppress an excluded tool's `tool_result` from markdown and the index, matching
  how its `tool_use` is already suppressed.
- Keep raw byte-for-byte lossless and unchanged.
- Keep `rebuild` correct — replaying raw in order must reproduce the filtered
  derived layers.
- No new dependencies, no config-format or storage-layout change.

**Non-Goals:**
- Persisting the call→result association across daemon restarts. A restart
  between the two lines may leak a single straggler result; that is accepted and
  `rebuild`-correctable.
- Filtering raw. Raw is never filtered by design.
- Pruning the in-memory id set. It only holds ids of *excluded* tool calls,
  which is empty for the common case (no `exclude_tools`) and tiny otherwise.

## Decisions

### Thread `tool_use_id` through the parser, not the raw JSON

`Entry::ToolUse` gains `id: Option<String>` (from `block["id"]`) and
`Entry::ToolResult` gains `tool_use_id: Option<String>` (from
`block["tool_use_id"]`). Both are populated by `parse_block` with the existing
`str_field` helper.

*Why:* The engine already consumes `jsonl::Entry`, not raw `Value`. Surfacing
the ids on the enum keeps the join in typed code and avoids re-parsing JSON in
the engine. Both fields are `Option` because the permissive parser must not
start rejecting lines that lack them — consistent with the module's contract
that unknown shapes degrade gracefully.

*Alternative considered:* Have the engine re-inspect the raw `Value` for ids.
Rejected — it duplicates parsing and breaks the clean `Entry` boundary.

### Make the filter stateful on the `Engine`

`Engine` gains `excluded_result_ids: HashSet<String>`. In `feed_derived`, before
the `retain`:
1. For each `Entry::ToolUse { id: Some(id), name, .. }` where `name` is
   excluded, insert `id` into the set.
2. `retain` drops excluded `ToolUse` (as today) **and** drops
   `Entry::ToolResult { tool_use_id: Some(id), .. }` when `id` is in the set.

Because a `tool_use` line is always captured before its `tool_result` line
(forward-only reads, ordered transcript), the set is populated before the result
is seen within a single daemon lifetime.

*Why a `HashSet` on the engine:* It is the smallest state that spans lines. The
id is removed when its `tool_result` is matched (each call has exactly one
result), so the set only ever holds *in-flight* excluded calls — typically 0–1 —
and cannot grow unbounded even for a long-lived daemon.

*Alternative considered:* An append-only set (never removing matched ids).
Simpler retain predicate, but it leaks one entry per excluded call for the
daemon's whole lifetime. `remove`-on-match costs nothing extra (the predicate
already looks the id up) and removes the leak, so it wins.

### Borrow-checker shape: two passes, not one closure

The current one-line `retain` closure cannot both mutate `self` (record ids) and
be the retain predicate. Split into an explicit pass that records excluded ids,
then a `retain` that reads the set. This keeps `&mut self` and the
`&parsed.entries` borrow from colliding.

## Risks / Trade-offs

- **Restart between call and result leaks one result** → Accepted and documented
  in the spec (`tool-exclusion`, best-effort requirement). Raw is unaffected, and
  `rebuild` — which replays in order under one process — re-filters it correctly.
- **In-memory set grows over a long daemon lifetime** → Ids are removed once
  their result is matched, so the set holds only in-flight excluded calls
  (typically 0–1). No unbounded growth; the only residue is excluded calls that
  never produce a result (e.g. an interrupted session), which is negligible.
- **Parser field additions ripple to all `Entry` match sites** →
  Compiler-enforced; `markdown.rs` and the `jsonl` unit tests update
  mechanically with no behavior change at those sites.
- **`rebuild` correctness depends on in-order replay** → `rebuild` already
  replays raw in file/offset order, so the call-before-result invariant holds.
