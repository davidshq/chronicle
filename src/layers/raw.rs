//! Raw JSONL archive — the lossless ground truth.
//!
//! This layer copies complete transcript lines **byte-for-byte** into a mirror
//! of the source directory structure. It never parses, filters, or truncates,
//! so it is immune to transcript-format drift and survives Claude Code's own
//! retention deletion. Append-only: existing bytes are never rewritten.

use anyhow::{Context, Result};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct RawArchive {
    root: PathBuf,
}

impl RawArchive {
    pub fn new(root: PathBuf) -> Self {
        RawArchive { root }
    }

    /// Append verbatim bytes (a run of one or more complete lines, including
    /// their trailing newlines) to the mirrored path `rel` under the archive.
    pub fn append(&self, rel: &Path, bytes: &[u8]) -> Result<()> {
        let dest = self.root.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating raw dir {}", parent.display()))?;
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&dest)
            .with_context(|| format!("opening raw archive {}", dest.display()))?;
        f.write_all(bytes)
            .with_context(|| format!("appending to {}", dest.display()))?;
        Ok(())
    }
}
