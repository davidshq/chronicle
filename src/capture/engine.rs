//! The shared capture engine.
//!
//! `sync_file` is the hot path: read the bytes appended since the last offset,
//! buffer any trailing partial line, append the complete lines verbatim to the
//! raw archive, and feed parsed entries to the derived layers. The offset only
//! ever advances to a newline boundary, so restarts and partial writes are safe.

use crate::capture::offset::OffsetStore;
use crate::config::Config;
use crate::db::Index;
use crate::jsonl;
use crate::layers::{markdown::MarkdownMirror, raw::RawArchive};
use crate::store::{Heartbeat, Store};
use anyhow::Result;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub struct Engine {
    cfg: Config,
    store: Store,
    offsets: OffsetStore,
    raw: Option<RawArchive>,
    md: Option<MarkdownMirror>,
    index: Option<Index>,
    started_at: String,
    /// Time of the last real capture write. Preserved across liveness-only
    /// ticks so `tick_heartbeat` can refresh `last_alive` without clobbering it.
    last_sync: String,
    /// `tool_use_id`s of excluded tool calls whose `tool_result` has not yet
    /// been seen, so the matching result (which arrives on a *later* transcript
    /// line and carries no tool name) can be dropped from the derived layers
    /// too. Ids are removed once their result is matched, so the set only holds
    /// *in-flight* excluded calls. A daemon restart between a call and its
    /// result loses the association (raw is unaffected; `rebuild` re-filters
    /// correctly).
    excluded_result_ids: std::collections::HashSet<String>,
}

impl Engine {
    pub fn new(cfg: Config) -> Result<Engine> {
        Self::new_inner(cfg, None)
    }

    /// Construct with an isolated offsets file (used by `rebuild` so a replay
    /// from the raw archive does not disturb the daemon's source offsets).
    pub fn new_with_offsets(cfg: Config, offsets_path: PathBuf) -> Result<Engine> {
        Self::new_inner(cfg, Some(offsets_path))
    }

    fn new_inner(cfg: Config, offsets_override: Option<PathBuf>) -> Result<Engine> {
        let store = Store::new(cfg.store_dir.clone());
        store.ensure_dirs()?;
        let offsets_path = offsets_override.unwrap_or_else(|| store.offsets_path());
        let offsets = OffsetStore::load(offsets_path)?;

        let raw = if cfg.layers.raw { Some(RawArchive::new(store.raw_dir())) } else { None };
        let md = if cfg.layers.markdown {
            Some(MarkdownMirror::new(store.markdown_dir(), cfg.max_tool_output_length))
        } else {
            None
        };
        let index = if cfg.layers.sqlite { Some(Index::open(&store.index_db_path())?) } else { None };

        let started_at = crate::commands::now_rfc3339();
        Ok(Engine {
            cfg,
            store,
            offsets,
            raw,
            md,
            index,
            last_sync: started_at.clone(),
            started_at,
            excluded_result_ids: std::collections::HashSet::new(),
        })
    }

    /// Resolve a source transcript path to its path relative to whichever
    /// watch dir contains it (used to mirror structure into the raw archive).
    fn rel_for(&self, path: &Path) -> PathBuf {
        for base in &self.cfg.watch_dirs {
            if let Ok(rel) = path.strip_prefix(base) {
                return rel.to_path_buf();
            }
        }
        // Fall back to the file name so we never write outside the archive root.
        PathBuf::from(path.file_name().unwrap_or_default())
    }

    /// Capture newly-appended lines from a single transcript file.
    /// Returns the number of complete lines captured.
    pub fn sync_file(&mut self, path: &Path) -> Result<usize> {
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => return Ok(0),
        };
        if !meta.is_file() {
            return Ok(0);
        }
        let len = meta.len();
        let mut start = self.offsets.get(path);
        // Truncation / rotation: file shrank below our offset — re-read from 0.
        if len < start {
            start = 0;
        }
        if start >= len {
            return Ok(0);
        }

        let mut f = std::fs::File::open(path)?;
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::with_capacity((len - start) as usize);
        f.read_to_end(&mut buf)?;

        // Partial-line buffering: only process through the last newline.
        let last_nl = match buf.iter().rposition(|&b| b == b'\n') {
            Some(idx) => idx,
            None => return Ok(0), // no complete line yet; leave offset untouched
        };
        let complete = &buf[..=last_nl];

        // 1) Raw layer: append the complete bytes verbatim (byte-for-byte).
        if let Some(raw) = &self.raw {
            let rel = self.rel_for(path);
            raw.append(&rel, complete)?;
        }

        // 2) Derived layers: parse each complete line.
        let text = String::from_utf8_lossy(complete);
        let mut count = 0usize;
        for line in text.split_inclusive('\n') {
            let line = line.strip_suffix('\n').unwrap_or(line);
            count += 1;
            self.feed_derived(path, line)?;
        }

        // Advance and persist the offset (newline boundary → restart-safe).
        self.offsets.set(path, start + last_nl as u64 + 1);
        self.offsets.persist()?;
        Ok(count)
    }

    fn feed_derived(&mut self, path: &Path, line: &str) -> Result<()> {
        if self.md.is_none() && self.index.is_none() {
            return Ok(());
        }
        let mut parsed = match jsonl::parse_line(line) {
            Some(p) if !p.is_empty() => p,
            _ => return Ok(()),
        };
        // Drop excluded tool activity once, up front, so *every* derived layer
        // (markdown and the SQLite index) sees the same filtered entries and
        // they can't drift. Raw is untouched — it always keeps the original.
        //
        // First record the id of every excluded tool *call*. A tool's *result*
        // arrives on a later transcript line with no tool name, linked only by
        // `tool_use_id`, so this set is how we recognize it. (Separate pass to
        // keep the `&mut self` insert out of the `retain` borrow below.)
        for e in &parsed.entries {
            if let jsonl::Entry::ToolUse { id: Some(id), name, .. } = e {
                if self.cfg.is_tool_excluded(name) {
                    self.excluded_result_ids.insert(id.clone());
                }
            }
        }
        // `remove` on a matched result keeps the set to only *in-flight* excluded
        // calls (each call has exactly one result), so it can't grow unbounded.
        let cfg = &self.cfg;
        let excluded_result_ids = &mut self.excluded_result_ids;
        parsed.entries.retain(|e| match e {
            jsonl::Entry::ToolUse { name, .. } => !cfg.is_tool_excluded(name),
            jsonl::Entry::ToolResult { tool_use_id: Some(id), .. } => {
                !excluded_result_ids.remove(id)
            }
            _ => true,
        });
        let session_id = parsed
            .session_id
            .clone()
            .unwrap_or_else(|| file_stem(path));
        let project_path = parsed.cwd.clone().unwrap_or_else(|| decoded_project(path));

        if self.cfg.is_project_excluded(&project_path) {
            return Ok(());
        }

        if let Some(index) = &self.index {
            let raw_rel = self.rel_for(path);
            index.upsert_session(
                &session_id,
                &project_path,
                parsed.timestamp.as_deref().unwrap_or(""),
                raw_rel.to_str(),
            )?;
            for (i, entry) in parsed.entries.iter().enumerate() {
                match entry {
                    jsonl::Entry::Text { role, text } => {
                        // A single transcript line can carry several text blocks
                        // that all share the line's uuid. Qualify the index key
                        // with the block's ordinal so sibling blocks don't
                        // collide on UNIQUE(session_id, uuid) — otherwise the
                        // second is silently dropped by INSERT OR IGNORE. It's
                        // deterministic, so re-indexing/rebuild stays idempotent.
                        let uuid = parsed.uuid.as_ref().map(|u| format!("{u}#{i}"));
                        index.insert_message(
                            &session_id,
                            uuid.as_deref(),
                            parsed.timestamp.as_deref().unwrap_or(""),
                            role,
                            text,
                            None,
                            None,
                            None,
                        )?;
                    }
                    jsonl::Entry::ToolUse { name, input, .. } => {
                        let input_json = serde_json::to_string(input).unwrap_or_default();
                        index.insert_message(
                            &session_id,
                            None,
                            parsed.timestamp.as_deref().unwrap_or(""),
                            "tool",
                            "",
                            Some(name),
                            Some(&input_json),
                            None,
                        )?;
                    }
                    jsonl::Entry::ToolResult { content, .. } => {
                        index.insert_message(
                            &session_id,
                            None,
                            parsed.timestamp.as_deref().unwrap_or(""),
                            "tool",
                            "",
                            None,
                            None,
                            Some(content),
                        )?;
                    }
                }
            }
        }

        if let Some(md) = &mut self.md {
            let p = md.write_line(&session_id, &project_path, &parsed)?;
            if let Some(index) = &self.index {
                if let Some(ps) = p.to_str() {
                    index.set_markdown_path(&session_id, ps).ok();
                }
            }
        }
        Ok(())
    }

    /// Walk all watch dirs and capture every `*.jsonl` file. Returns lines captured.
    pub fn scan_all(&mut self) -> Result<usize> {
        let mut total = 0;
        let dirs = self.cfg.watch_dirs.clone();
        for dir in dirs {
            let mut files = Vec::new();
            collect_jsonl(&dir, &mut files);
            for f in files {
                total += self.sync_file(&f)?;
            }
        }
        if total > 0 {
            self.touch_heartbeat()?;
        }
        Ok(total)
    }

    /// Record a real capture: advance both `last_sync` and `last_alive` to now.
    /// Call this only when data was actually written.
    pub fn touch_heartbeat(&mut self) -> Result<()> {
        self.last_sync = crate::commands::now_rfc3339();
        self.write_heartbeat()
    }

    /// Prove liveness without a capture: advance only `last_alive`, preserving
    /// the last real `last_sync`. This is the timer tick that lets the watchdog
    /// distinguish an idle-but-live daemon from a wedged one.
    pub fn tick_heartbeat(&self) -> Result<()> {
        self.write_heartbeat()
    }

    fn write_heartbeat(&self) -> Result<()> {
        let hb = Heartbeat {
            pid: std::process::id(),
            started_at: self.started_at.clone(),
            last_sync: self.last_sync.clone(),
            last_alive: crate::commands::now_rfc3339(),
        };
        Heartbeat::write(&self.store, &hb)
    }
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown-session".to_string())
}

/// Claude Code encodes the project path as the parent directory name with
/// non-alphanumerics replaced by `-`. We can't perfectly invert it, so we use
/// the decoded-ish directory name as a readable fallback when `cwd` is absent.
fn decoded_project(path: &Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().replace('-', "/"))
        .unwrap_or_else(|| "unknown".to_string())
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(path);
        }
    }
}
