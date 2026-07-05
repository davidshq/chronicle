//! Configuration model and loading.
//!
//! Ported in spirit from the old `src/config.ts`: layer toggles, exclusions,
//! debug, and a consent-style master switch — plus the new capture-mode and
//! store-layout settings the daemon needs. Raw capture is *never* truncated;
//! `max_tool_output_length` only bounds the derived markdown layer.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Which output layers the daemon writes. Each is independently opt-in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layers {
    /// Verbatim JSONL archive — the lossless ground truth. On by default.
    #[serde(default = "def_true")]
    pub raw: bool,
    /// Human-readable markdown mirror, derived from raw.
    #[serde(default = "def_true")]
    pub markdown: bool,
    /// SQLite + FTS index, derived from raw.
    #[serde(default = "def_true")]
    pub sqlite: bool,
}

impl Default for Layers {
    fn default() -> Self {
        Layers { raw: true, markdown: true, sqlite: true }
    }
}

/// How capture is triggered.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum CaptureMode {
    /// Live filesystem-watch (default): lightest at idle.
    #[default]
    Live,
    /// Periodic polling fallback where watch APIs are restricted.
    Poll {
        #[serde(default = "def_poll_interval")]
        interval_ms: u64,
    },
}

/// Opt-in, LLM-powered narrative summary layer. Disabled by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SummaryConfig {
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Master switch (ported from old `enabled`). When false, the daemon idles.
    #[serde(default = "def_true")]
    pub enabled: bool,

    /// Chronicle's own store root (raw archive, markdown, index, state, config).
    ///
    /// Resolved at load time by `resolve_store_dir` and always overwritten with
    /// that value, because the config file lives *inside* the store — editing
    /// this field in `config.json` has no effect. To relocate the store, point
    /// the anchor's `store-path` file at the new dir (`install.sh --store` writes
    /// it, or edit the file directly). Not serialized back out: it's always
    /// recomputed on load, so writing it into `config.json` would only advertise
    /// a knob that has no effect (and could mislead someone into editing it).
    #[serde(default = "default_store_dir", skip_serializing)]
    pub store_dir: PathBuf,

    /// Directories to watch for Claude Code transcript JSONL files.
    #[serde(default = "default_watch_dirs")]
    pub watch_dirs: Vec<PathBuf>,

    #[serde(default)]
    pub layers: Layers,

    #[serde(default)]
    pub capture: CaptureMode,

    #[serde(default)]
    pub summaries: SummaryConfig,

    /// Substring matches on a session's project path that suppress capture.
    #[serde(default)]
    pub exclude_projects: Vec<String>,

    /// Tool names omitted from the derived layers (raw still keeps everything).
    /// Both the tool's *call* and its *result* are suppressed from markdown and
    /// the index; the result is matched to its call by `tool_use_id`, so a
    /// daemon restart between the two transcript lines may let a single straggler
    /// result through until the next `rebuild`.
    #[serde(default)]
    pub exclude_tools: Vec<String>,

    /// Truncation bound for the markdown layer only. Raw is never truncated.
    #[serde(default = "def_max_tool_output")]
    pub max_tool_output_length: usize,

    /// Debounce window for the SQLite/FTS indexer, in milliseconds.
    #[serde(default = "def_debounce")]
    pub index_debounce_ms: u64,

    /// Staleness threshold (seconds) after which the watchdog warns.
    #[serde(default = "def_staleness")]
    pub staleness_secs: u64,

    #[serde(default)]
    pub debug: bool,
}

fn def_true() -> bool {
    true
}
fn def_poll_interval() -> u64 {
    2000
}
fn def_max_tool_output() -> usize {
    2000
}
fn def_debounce() -> u64 {
    30_000
}
fn def_staleness() -> u64 {
    7200
}

/// Name of the one-line pointer file inside the anchor dir. Its contents are the
/// store directory; absent (or empty) means the store *is* the anchor.
const STORE_POINTER: &str = "store-path";

/// Chronicle's fixed anchor directory, `~/.chronicle`. Known a priori — with no
/// environment or prior config — so any process can find its way to the store.
/// It holds the installed binary and, when the store lives elsewhere, the
/// `store-path` pointer that redirects to it.
fn anchor_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".chronicle")
}

/// Resolve where the store (config + data layers) lives, without reading any
/// config (that would be circular — config lives *in* the store).
///
/// Precedence: an explicit `--store` wins; else the `store-path` pointer in the
/// anchor dir, if present and non-empty; else the anchor dir itself. This is a
/// pure function of on-disk state — no daemon, no env — so the daemon, the
/// plugin, and every CLI command agree on the store with nothing to keep "in
/// sync". A pointer can't drift from what it points at.
fn resolve_store_dir_in(anchor: &Path, override_dir: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = override_dir {
        return dir;
    }
    if let Ok(contents) = std::fs::read_to_string(anchor.join(STORE_POINTER)) {
        let trimmed = contents.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    anchor.to_path_buf()
}

fn resolve_store_dir(override_dir: Option<PathBuf>) -> PathBuf {
    resolve_store_dir_in(&anchor_dir(), override_dir)
}

/// Used only as the `store_dir` field's serde/`Default` seed; the real value is
/// always recomputed by `load()` via `resolve_store_dir`.
fn default_store_dir() -> PathBuf {
    resolve_store_dir(None)
}

fn default_watch_dirs() -> Vec<PathBuf> {
    let mut dirs_out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs_out.push(home.join(".claude").join("projects"));
    }
    dirs_out
}

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: true,
            store_dir: default_store_dir(),
            watch_dirs: default_watch_dirs(),
            layers: Layers::default(),
            capture: CaptureMode::default(),
            summaries: SummaryConfig::default(),
            exclude_projects: Vec::new(),
            exclude_tools: Vec::new(),
            max_tool_output_length: def_max_tool_output(),
            index_debounce_ms: def_debounce(),
            staleness_secs: def_staleness(),
            debug: false,
        }
    }
}

impl Config {
    /// Path to the config file within the store dir.
    pub fn config_path(store_dir: &std::path::Path) -> PathBuf {
        store_dir.join("config.json")
    }

    /// Load config from `<store_dir>/config.json`, falling back to defaults.
    /// The store is located by `resolve_store_dir` (explicit `--store`, else the
    /// anchor's `store-path` pointer, else `~/.chronicle`) — never from the
    /// config itself, which lives inside the store.
    pub fn load(store_override: Option<PathBuf>) -> Result<Config> {
        let store_dir = resolve_store_dir(store_override);
        let path = Self::config_path(&store_dir);
        let mut cfg = if path.exists() {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading config at {}", path.display()))?;
            let mut cfg: Config = serde_json::from_str(&text)
                .with_context(|| format!("parsing config at {}", path.display()))?;
            // An explicit --store always wins over a persisted store_dir.
            cfg.store_dir = store_dir.clone();
            cfg
        } else {
            Config { store_dir: store_dir.clone(), ..Default::default() }
        };
        // Normalize: ensure at least one watch dir.
        if cfg.watch_dirs.is_empty() {
            cfg.watch_dirs = default_watch_dirs();
        }
        Ok(cfg)
    }

    /// Persist config to disk (used by `migrate` and first-run setup).
    pub fn save(&self) -> Result<()> {
        std::fs::create_dir_all(&self.store_dir)
            .with_context(|| format!("creating store dir {}", self.store_dir.display()))?;
        let path = Self::config_path(&self.store_dir);
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, text)
            .with_context(|| format!("writing config to {}", path.display()))?;
        Ok(())
    }

    pub fn is_project_excluded(&self, project_path: &str) -> bool {
        self.exclude_projects
            .iter()
            .any(|ex| project_path.contains(ex))
    }

    /// A tool whose calls are omitted from every derived layer (raw keeps all).
    pub fn is_tool_excluded(&self, tool_name: &str) -> bool {
        self.exclude_tools.iter().any(|t| t == tool_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_resolution_precedence() {
        let anchor = std::env::temp_dir().join(format!("chronicle-anchor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&anchor);
        std::fs::create_dir_all(&anchor).unwrap();

        // No pointer, no override → the anchor itself is the store.
        assert_eq!(resolve_store_dir_in(&anchor, None), anchor);

        // Pointer present → its contents, whitespace-trimmed.
        std::fs::write(anchor.join(STORE_POINTER), "  /mnt/data/chronicle \n").unwrap();
        assert_eq!(
            resolve_store_dir_in(&anchor, None),
            PathBuf::from("/mnt/data/chronicle")
        );

        // An explicit --store beats the pointer.
        assert_eq!(
            resolve_store_dir_in(&anchor, Some(PathBuf::from("/tmp/override"))),
            PathBuf::from("/tmp/override")
        );

        // An empty/whitespace pointer is ignored → back to the anchor.
        std::fs::write(anchor.join(STORE_POINTER), "\n").unwrap();
        assert_eq!(resolve_store_dir_in(&anchor, None), anchor);

        let _ = std::fs::remove_dir_all(&anchor);
    }
}
