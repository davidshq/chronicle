//! On-disk store layout and the daemon heartbeat.
//!
//! ```text
//! <store_dir>/                     (default ~/.chronicle)
//!   config.json                    user config
//!   heartbeat.json                 { pid, started_at, last_sync, last_alive }  <- watchdog reads this
//!   state/offsets.json             per-file byte offsets (restart-safe capture)
//!   raw/<project>/<session>.jsonl  verbatim archive (ground truth)
//!   markdown/<YYYY-MM-DD>/*.md      rendered mirror
//!   index.db                       SQLite + FTS
//! ```

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Store { root }
    }

    pub fn raw_dir(&self) -> PathBuf {
        self.root.join("raw")
    }
    pub fn markdown_dir(&self) -> PathBuf {
        self.root.join("markdown")
    }
    pub fn index_db_path(&self) -> PathBuf {
        self.root.join("index.db")
    }
    pub fn state_dir(&self) -> PathBuf {
        self.root.join("state")
    }
    pub fn offsets_path(&self) -> PathBuf {
        self.state_dir().join("offsets.json")
    }
    pub fn heartbeat_path(&self) -> PathBuf {
        self.root.join("heartbeat.json")
    }

    /// Create the base directory layout.
    pub fn ensure_dirs(&self) -> Result<()> {
        for d in [self.raw_dir(), self.markdown_dir(), self.state_dir()] {
            std::fs::create_dir_all(&d)
                .with_context(|| format!("creating {}", d.display()))?;
        }
        Ok(())
    }
}

/// Liveness/freshness signal the daemon writes and the watchdog reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heartbeat {
    pub pid: u32,
    /// RFC3339 timestamp the daemon started.
    pub started_at: String,
    /// RFC3339 timestamp of the most recent successful capture write.
    pub last_sync: String,
    /// RFC3339 timestamp of the daemon's most recent proof of liveness. Unlike
    /// `last_sync` this advances on a timer *independent of capture activity*
    /// (see the tick in `capture::watch`), so an idle-but-live daemon can be
    /// told apart from a wedged one. Empty for heartbeats written before this
    /// field existed; readers fall back to `last_sync` in that case.
    #[serde(default)]
    pub last_alive: String,
}

impl Heartbeat {
    pub fn write(store: &Store, hb: &Heartbeat) -> Result<()> {
        let path = store.heartbeat_path();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(hb)?)?;
        // Atomic replace so a reader never sees a half-written file.
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn read(path: &Path) -> Result<Option<Heartbeat>> {
        if !path.exists() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(path)?;
        Ok(Some(serde_json::from_str(&text)?))
    }
}

/// True if a process with `pid` is currently alive (best-effort, Unix).
#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    // signal 0 performs error checking without sending a signal.
    unsafe { libc_kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[cfg(not(unix))]
pub fn process_alive(_pid: u32) -> bool {
    // Fallback: assume alive; freshness check still catches a dead daemon.
    true
}
