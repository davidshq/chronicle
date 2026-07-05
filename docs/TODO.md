# Chronicle — TODO / Roadmap

Deferred work, captured so it isn't lost. The lossless core (capture + layered
storage + watchdog plugin) is built and tested; the items below are follow-ups.

## Phase 7 — Narrative summaries (opt-in, LLM-powered) — NOT STARTED

The one intentionally-lossy layer. It sits **on top of** the lossless raw
archive and never replaces it — every summary points back to the exact source.
Disabled by default (`summaries.enabled = false`); zero LLM calls and zero
artifacts when off. This layer is the only part of Chronicle that costs money
or needs the network, so it stays strictly isolated from the free/reliable core.

### What it should produce
A human-readable "how the code evolved" narrative per session that lets someone
understand the arc of a session **without reading the full logs** — while still
being able to drill into any moment.

Key behaviors:
- **Rabbit-hole compression with dead-end retention.** Detours are compressed
  but *named*: "tried JWT-in-cookie → abandoned (CSRF concerns) → reverted →
  landed on header tokens." We record that the detour happened and why it was
  abandoned, rather than omitting it (loses the lesson) or reproducing it in
  full (defeats the purpose).
- **Cross-references to the raw archive.** Every statement links to the exact
  raw-archive line range(s) it summarizes, so a reader can jump from narrative
  to ground truth. The raw archive is never modified.
- **Trigger:** on session boundary (session considered "done") or on demand.

### Open design decisions (resolve before building)
- **Which model / runtime.** Chronicle is otherwise dependency-free and offline;
  summaries need an LLM. Options: call the Anthropic API directly (which model,
  cost per session?), shell out to the user's existing `claude` CLI, or make the
  provider pluggable. Default to the latest cheap-but-capable Claude model
  (e.g. Haiku-tier) for cost.
- **Cross-reference anchoring.** How to stably reference raw lines: byte-offset
  ranges? line-number ranges? message UUIDs? UUIDs are most stable across
  re-renders and are already captured — likely the right anchor.
- **Cost controls.** Per-session token budget, opt-in per-project, and a dry-run
  that estimates cost before enabling.
- **Storage.** Where summaries live (e.g. `~/.chronicle/summaries/<session>.md`)
  and how they embed the cross-reference links.

### Spec
See `openspec/changes/chronicle-external-recorder/specs/narrative-summaries/spec.md`
for the normative requirements and scenarios.

## Smaller follow-ups

- **Timed index debounce.** `index_debounce_ms` exists in config but is not yet
  wired to a timer; SQLite/FTS inserts are currently batched per file-sync.
  Add a debounce so bursts of rapid writes coalesce into fewer index commits.

## Phase 9 — Cross-tool capture (future, not v1)

Adapters for Codex / Cursor / Gemini: each is "a new watch path + a format
adapter" over the same capture engine (e.g. `~/.codex/sessions`). The raw layer
is tool-agnostic already; only the derived-layer parser needs per-tool shapes.

---