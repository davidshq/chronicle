## Context

`claude-remember` today is a Bun/TS Claude Code plugin that captures sessions via hooks and writes markdown + SQLite to `~/.claude-logs/`. Investigation (see `proposal.md`) established three things: (1) Claude Code hooks fail *silently* in exactly the scenarios we care about (long sessions, `/compact`, `/exit`), so hook-based capture cannot be trusted to be complete; (2) the on-disk JSONL transcripts are the richest, most complete record and — under normal compaction — are **append-only and preserved on disk**, with the real durability threat being retention auto-deletion of old files, not compaction; (3) the "memory" market is saturated with lossy-by-design summarizers, leaving the **lossless live recorder** niche open.

The user has chosen a **greenfield rewrite with selective salvage**, renaming the repo to `chronicle` in place and doing the rewrite on a fresh branch. This design covers how the new two-component system (`chronicled` daemon + `chronicle` plugin) is structured.

## Goals / Non-Goals

**Goals:**
- Capture is **lossless** and **independent of Claude Code hooks** — it survives hook failure, `/exit`, crashes, and long sessions.
- Raw JSONL ground truth is preserved verbatim and **deletion-proof**.
- Storage is layered and independently configurable: raw JSONL, markdown mirror, SQLite/FTS index.
- Narrative summaries are an *opt-in derived layer* that never replaces the source and always cross-references it.
- The plugin reliably tells the user *in-session* when capture is broken or stale.
- Capture cost at idle is negligible.

**Non-Goals:**
- Context re-injection into future sessions (the `claude-mem`/`remember` lane — deliberately not ours).
- Cross-tool capture (Codex/Cursor/Gemini) in v1 — the design must not *preclude* it, but it is a later phase.
- Real-time sub-second guarantees. Compaction is append-only, so near-real-time is sufficient.
- Server/cloud sync — everything is local-first.

## Decisions

### D1 — External daemon (`chronicled`) owns capture; the plugin never captures
**Why:** Hooks are best-effort and fail silently ([#16047](https://github.com/anthropics/claude-code/issues/16047), [#51420](https://github.com/anthropics/claude-code/issues/51420), [#13572](https://github.com/anthropics/claude-code/issues/13572)). A process that watches files on disk is independent of Claude's lifecycle. **Alternative considered:** keep hook capture but add a PreCompact backup (current design, and `claude-vault`'s model) — rejected because it inherits the exact silent-failure modes. **Alternative:** pty-wrap `claude` and tee stdout — rejected because it captures rendered terminal output, not the structured JSONL.

### D2 — Capture by watching on-disk JSONL, not by intercepting a stream
**Why:** There is no stream to pipe; Claude Code writes JSONL files. The engine tracks a **byte-offset per file**, reads new bytes on trigger, buffers partial lines to the last newline, appends verbatim to the raw archive, and persists offsets so a restart resumes cleanly (never re-copies, never skips).

### D3 — Live-by-default trigger, periodic-poll fallback, one shared engine
**Why:** "Live" (filesystem-watch: inotify/FSEvents/ReadDirectoryChangesW) and "periodic" (timer) differ only in the *trigger*; they share offset tracking, partial-line buffering, and archive writing. Live is *lighter at idle* (blocked on the kernel, zero CPU until a write) and protects against the rare compaction-failure corruption bug ([#40352](https://github.com/anthropics/claude-code/issues/40352)); periodic is the fallback where watch APIs are restricted or watch-descriptor limits bite. Because normal compaction is append-only, periodic cadence (seconds) still comfortably beats retention deletion (days).

### D4 — Layered storage; raw JSONL is ground truth, everything else derives
**Why:** The user wants raw JSONL **and** markdown **and** SQLite as options. Raw JSONL copy is near-free (append new lines, no parsing, format-fragility-proof) and is the truest lossless layer. Markdown mirror and SQLite/FTS index are *renderings/indexes* built over the raw layer and are individually opt-in. **Cadence by layer:** raw = live/continuous; SQLite/FTS = **debounced** (e.g. on idle or every ~30s) so we don't write an FTS row per keystroke; narrative = on session boundary / on demand.

### D5 — Narrative summaries are opt-in, LLM-powered, and always cross-referenced
**Why:** Lossy is safe *only* because it points back at the lossless source. Summaries compress rabbit holes but must *name* the dead-ends and link to the exact raw-archive line ranges. This is the one layer that costs money and needs the network, so it is strictly opt-in and isolated from the free/reliable core (D4 layers 1–2).

### D6 — Plugin = thin watchdog + retrieval UI; hooks used only for monitoring
**Why:** Role inversion — the plugin no longer *is* the capture, it *watches* it. It reads a daemon heartbeat + store freshness signals (process liveness, DB mtime advancing, last-sync timestamp) and warns in-session when stale. Using hooks here is safe: if a monitoring hook silently dies, the user just misses a warning; capture is unaffected.

### D7 — One Rust binary serves both the daemon and the plugin CLI; drop Bun/TS
**Why:** Claude Code plugins are language-agnostic — hooks and MCP servers invoke *any* executable (docs support spawning a binary via `execve`; `claude-hook-advisor` is a Rust hook binary dispatching subcommands via `${CLAUDE_PLUGIN_ROOT}/bin/...`). So nothing requires TS. A single Rust binary with git-style subcommands (`chronicle daemon` / `search` / `status` / `watchdog` / `migrate`) serves both roles, letting the store-**writer** (daemon) and store-**reader** (plugin CLI) share one schema, types, and FTS query layer with no cross-language boundary. Markdown commands/skills stay markdown and call the binary. **Rust over Go:** smallest footprint for an always-on process, no GC, `rusqlite` bundles SQLite+FTS5 cleanly, `notify` for filewatch, and direct in-niche reference code exists (`claude-vault`, `ccboard`, `claude-hook-advisor` are all Rust). **Alternatives considered:** Bun/TS daemon (max code reuse with old plugin, but heavier always-on footprint and keeps the lossy legacy structure) — rejected; Go (faster iteration, effortless cross-compile) — viable, but Rust wins on footprint and in-niche precedent. The plugin no longer contains a TS runtime at all.

### D8 — Greenfield with selective salvage; rename repo in place
Port by reference: markdown render format, SQLite schema shape, retrieval command UX, config semantics (per-project enable/disable, exclusions, consent). Drop: `handler.ts`, `transcript.ts` (hook capture + lossy extraction). Rename `claude-remember` → `chronicle` preserving history/issues; rewrite on a fresh branch before replacing `main`.

## Risks / Trade-offs

- **[Daemon isn't running → silent capture gap]** → The watchdog plugin (D6) exists precisely to surface this in-session; onboarding installs the daemon as a managed service (launchd/systemd) with auto-restart.
- **[File-watch edge cases: partial lines, new-file detection, watch-descriptor limits, cross-platform APIs]** → Use a mature watch library (Rust `notify` / `Bun.watch`); buffer to last newline; watch the *directory* for new session files; cap/rotate watches on old inactive files.
- **[Rust iteration/learning cost vs old TS velocity]** → Accepted trade for footprint, single-language unification, and in-niche reference code; the unified binary removes the TS/Rust boundary entirely.
- **[Compaction-failure corruption bug destroys a transcript before we copy it]** → Live/continuous tail (D3) minimizes the window; raw archive is append-only and never rewritten by us.
- **[Distribution complexity: users must install a daemon, not just a plugin]** → One-command installer; plugin detects missing daemon and guides setup.
- **[Migration from `~/.claude-logs/` + old config]** → Provide a one-time migration that maps old output/config onto the Chronicle layered model under the new identity.

## Migration Plan

1. Rename repo `claude-remember` → `chronicle`; update marketplace manifest/identity.
2. Build daemon + plugin on a fresh branch; keep `main` installable until parity.
3. Ship a migration step: map `~/.claude-logs/` + `config.json` + `.claude-remember.json` to the new layered store/config, renamed under Chronicle.
4. Cut `main` over once capture parity + watchdog are verified. **Rollback:** the old plugin remains installable from a tagged pre-pivot release.

## Open Questions

- Store layout/contract between daemon and plugin (paths, heartbeat file, freshness signal) — define before implementation. (Language resolved: single Rust binary — see D7.)
- Exact staleness thresholds and warning copy for the watchdog.
- Which LLM/runtime powers narrative summaries, and how line-range cross-references are anchored to the raw archive.
- Does renaming the marketplace plugin id break existing installs, and is a compatibility alias needed?
