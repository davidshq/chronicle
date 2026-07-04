//! Restart-safe per-file byte-offset tracking.
//!
//! The offset for a file is the number of bytes that have been *fully*
//! consumed — always a newline boundary. Persisting it means a restart
//! resumes exactly where capture left off, never re-copying or skipping.

use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct OffsetStore {
    path: PathBuf,
    map: HashMap<String, u64>,
    dirty: bool,
}

impl OffsetStore {
    pub fn load(path: PathBuf) -> Result<OffsetStore> {
        let map = if path.exists() {
            let text = std::fs::read_to_string(&path)?;
            serde_json::from_str(&text).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(OffsetStore { path, map, dirty: false })
    }

    fn key(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    pub fn get(&self, p: &Path) -> u64 {
        self.map.get(&Self::key(p)).copied().unwrap_or(0)
    }

    pub fn set(&mut self, p: &Path, offset: u64) {
        self.map.insert(Self::key(p), offset);
        self.dirty = true;
    }

    /// Persist offsets atomically (temp file + rename) if changed.
    pub fn persist(&mut self) -> Result<()> {
        if !self.dirty {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&self.map)?)?;
        std::fs::rename(&tmp, &self.path)?;
        self.dirty = false;
        Ok(())
    }
}
