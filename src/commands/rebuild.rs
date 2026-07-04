//! `chronicle rebuild` — regenerate derived layers from the raw archive.
//!
//! Proves that raw is the ground truth: the markdown mirror and SQLite/FTS index
//! can be deleted and reconstructed entirely from `raw/`, with no data loss.

use crate::capture::Engine;
use crate::store::Store;
use anyhow::Result;
use clap::Args;
use std::path::PathBuf;

#[derive(Args)]
pub struct RebuildArgs {
    #[arg(long)]
    store: Option<PathBuf>,
}

pub fn run(args: RebuildArgs) -> Result<()> {
    let n = rebuild(args.store)?;
    println!("Rebuilt derived layers from raw archive: {n} line(s) reprocessed.");
    Ok(())
}

/// Rebuild derived layers from the raw archive. Returns lines reprocessed.
pub fn rebuild(store_override: Option<PathBuf>) -> Result<usize> {
    let cfg = super::load_config(store_override)?;
    let store = Store::new(cfg.store_dir.clone());

    // 1) Drop derived layers.
    let db = store.index_db_path();
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{}", db.display(), suffix));
        std::fs::remove_file(&p).ok();
    }
    std::fs::remove_dir_all(store.markdown_dir()).ok();

    // 2) Replay the raw archive through the derived layers only.
    let mut rebuild_cfg = cfg.clone();
    rebuild_cfg.layers.raw = false; // do not re-copy raw onto itself
    rebuild_cfg.watch_dirs = vec![store.raw_dir()];

    // Isolated, fresh offsets so the full raw archive is replayed every time.
    let rebuild_offsets = store.state_dir().join("rebuild-offsets.json");
    std::fs::remove_file(&rebuild_offsets).ok();
    let mut engine = Engine::new_with_offsets(rebuild_cfg, rebuild_offsets.clone())?;
    let n = engine.scan_all()?;
    std::fs::remove_file(&rebuild_offsets).ok();
    Ok(n)
}
