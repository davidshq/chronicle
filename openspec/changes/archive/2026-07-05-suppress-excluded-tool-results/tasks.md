## 1. Parser: surface the join ids

- [x] 1.1 Add `id: Option<String>` to `jsonl::Entry::ToolUse` and
  `tool_use_id: Option<String>` to `jsonl::Entry::ToolResult` (`src/jsonl.rs`).
- [x] 1.2 Populate them in `parse_block` from `block["id"]` /
  `block["tool_use_id"]` using the existing `str_field` helper.
- [x] 1.3 Update the `jsonl` unit tests to construct/assert the new fields; add a
  test that a `tool_result` block's `tool_use_id` is parsed.

## 2. Engine: stateful suppression of excluded results

- [x] 2.1 Add `excluded_result_ids: HashSet<String>` to `Engine` and initialize
  it in the constructor (`src/capture/engine.rs`).
- [x] 2.2 In `feed_derived`, before the `retain`, record the `id` of every
  `Entry::ToolUse` whose name `is_tool_excluded` into the set.
- [x] 2.3 Extend the `retain` to also drop `Entry::ToolResult` whose
  `tool_use_id` is in the set (split into record-pass + retain-pass to satisfy
  the borrow checker).
- [x] 2.4 Add a code comment noting the set holds only excluded-call ids and is
  intentionally not pruned.

## 3. Match-site fixups (no behavior change)

- [x] 3.1 Update the `Entry::ToolUse` / `Entry::ToolResult` match arms in
  `src/layers/markdown.rs` to the new field shape.
- [x] 3.2 Update any remaining `Entry` match/construction sites flagged by the
  compiler.

## 4. Docs

- [x] 4.1 Update the `exclude_tools` doc comment in `src/config.rs` to state that
  both the tool call and its result are suppressed from derived layers.

## 5. Tests

- [x] 5.1 Integration test: with `exclude_tools = ["Bash"]`, feed a `tool_use`
  line then a matching `tool_result` line; assert the result is absent from both
  markdown and the index, and present in raw.
- [x] 5.2 Test that a non-excluded tool's `tool_result` is retained in derived
  layers.
- [x] 5.3 Test that `rebuild` reproduces the filtered derived layers (excluded
  call and result both absent) from raw.

## 6. Verification

- [x] 6.1 Run `cargo build`, `cargo test`, and `cargo clippy -- -D warnings`;
  fix any failures.
