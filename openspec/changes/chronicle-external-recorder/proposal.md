## Why

The current plugin (`claude-remember`) captures sessions **inside** Claude Code via the hooks system. That architecture is fundamentally unable to deliver the one thing the tool is for — a record you can *trust to be complete*. Claude Code hooks are best-effort and fail **silently**: they stop firing after ~2.5 hours in long sessions ([#16047](https://github.com/anthropics/claude-code/issues/16047)), plugin-scoped `Stop` hooks go silent mid-session after registry reloads ([#51420](https://github.com/anthropics/claude-code/issues/51420)), `SessionEnd` is killed before async work finishes ([#41577](https://github.com/anthropics/claude-code/issues/41577)) and doesn't fire on `/exit` ([#17885](https://github.com/anthropics/claude-code/issues/17885)), and `PreCompact` isn't triggered by `/compact` ([#13572](https://github.com/anthropics/claude-code/issues/13572)). The events most likely to fail are exactly the two the current design depends on most. On top of that, the current capture path is itself lossy — it reconstructs a **truncated** summary from hook payloads and extracts only the *last* assistant message per turn, rather than preserving what actually happened.

Meanwhile the "memory" niche is saturated with **lossy-by-design** tools (`claude-mem`, official `remember`, `supermemory`) that AI-compress sessions and throw the originals away — the exact information loss we want to avoid. The open, unoccupied niche is a **lossless live recorder**: capture everything faithfully, keep the raw ground truth forever, and *derive* readable summaries on top without ever discarding the source.

## What Changes

- **BREAKING — Rename the project to `Chronicle`.** The plugin becomes `chronicle`; a new external daemon is `chronicled`. This differentiates from the overloaded `remember`/`mem`/`memory` namespace and reflects the new architecture (a faithful record rendered as narrative).
- **BREAKING — Move capture out of Claude Code into an external daemon (`chronicled`).** Capture no longer depends on hooks firing. The daemon watches the on-disk session transcripts (`~/.claude/projects/**/*.jsonl`) independently of Claude's lifecycle, so it survives hook failure, `/exit`, crashes, and long sessions.
- **Live-by-default capture with a periodic-poll fallback.** A single capture engine tracks a byte-offset per file and appends new lines; the *trigger* is a filesystem-watch event by default (lightest at idle) or a timer where watch APIs are restricted. Compaction is append-only on disk ([session-continuation mechanics](https://blog.fsck.com/agent-blog/2026/02/22/claude-code-session-continuation/)), so periodic cadence comfortably beats the real enemy — retention auto-deletion of old files.
- **Layered, configurable storage.** Raw JSONL archive (verbatim, deletion-proof ground truth) + markdown mirror + SQLite/FTS index. Each is independently opt-in; markdown and SQLite are *renderings/indexes* over the raw layer, never replacements.
- **Derived, cross-referenced narrative summaries (opt-in, LLM-powered).** A human-readable "how the code evolved" layer that compresses rabbit holes while still *naming* them and their dead-ends, with links back to the exact raw lines. Lossy is safe here because it always points at the lossless source.
- **The plugin is demoted to a thin watchdog + retrieval UI.** It keeps `search`/`today`/`status`, and adds health monitoring that warns in-session when the daemon is down or the store has gone stale ("recorder hasn't synced in 2h", "can't reach the recorder / DB not updating"). Hooks are now used only for *monitoring*, where a silent failure is harmless.
- **Cross-tool capture (Codex/Cursor/Gemini) is explicitly a later phase**, enabled by the tail-a-directory design (new log path + format adapter), not part of v1.

## Capabilities

### New Capabilities
- `lossless-capture`: The external `chronicled` daemon tails Claude Code session transcripts and preserves every line verbatim, independent of the hook system; live-by-default with a periodic-poll fallback and restart-safe offset tracking.
- `layered-storage`: Configurable, independently opt-in output layers — raw JSONL archive (ground truth), markdown mirror, and SQLite/FTS index — where derived layers reference the raw layer.
- `narrative-summaries`: Opt-in, LLM-derived narrative summaries that compress rabbit holes yet record dead-ends and cross-reference back to the raw archive.
- `recorder-watchdog`: The `chronicle` plugin monitors daemon liveness and store freshness and surfaces in-session warnings when capture is failing or stale.
- `session-search`: User-facing retrieval over the store — `search`, `today`, and `status` commands.

### Modified Capabilities
<!-- None. openspec/specs/ is currently empty; this is the first change. -->

## Impact

- **Approach — greenfield rewrite with selective salvage.** The current hook-based codebase is not migrated forward. A clean structure is built around the daemon+plugin split; only four self-contained pieces are deliberately ported *by reference*: the markdown render format (`markdown.ts` → markdown-mirror layer), the SQLite schema shape (`db.ts` → index starting point), the retrieval command UX (`commands/*.md`), and config semantics (per-project enable/disable, exclusions, consent). The hook capture path (`handler.ts`, `transcript.ts`) is dropped.
- **Repo strategy — rename in place, rewrite on a fresh branch.** `claude-remember` is renamed to `chronicle` (preserving git history, issues, and existing users); the greenfield rewrite lands on a new branch before replacing `main`.
- **BREAKING — Rewrite in Rust as a single binary; drop Bun/TS.** Claude Code plugins are language-agnostic (hooks/MCP invoke any executable), so one Rust binary with git-style subcommands (`chronicle daemon` / `search` / `status` / `watchdog` / `migrate`) serves both the always-on daemon and the plugin CLI, sharing schema/types/FTS between store-writer and store-reader. Markdown commands/skills stay markdown and call the binary.
- **Distribution change:** from plugin-install only to plugin + daemon install (launchd/systemd/service management) — a new install/onboarding surface.
- **Data/config migration:** existing `~/.claude-logs/` layout, `config.json`, and `.claude-remember.json` per-project config map onto the new layered model and are renamed under the Chronicle identity.
- **Existing prior art to reference (not adopt):** `claude-vault` (lossy strip + hook-triggered, SQLite-only), `claude-code-trace` (proves live JSONL tailing works). Neither meets the lossless + multi-format + watchdog bar.
- **Non-goals for v1:** cross-tool capture, context re-injection into future sessions (that's the `claude-mem`/`remember` lane we are deliberately *not* in).
