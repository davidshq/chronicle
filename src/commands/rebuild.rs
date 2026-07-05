//! `chronicle rebuild` — regenerate derived layers from the raw archive.
//!
//! Proves that raw is the ground truth: the markdown mirror and SQLite/FTS index
//! can be deleted and reconstructed entirely from `raw/`, with no data loss.

use crate::capture::Engine;
use crate::store::Store;
use anyhow::{Context, Result};
use clap::Args;
use std::path::{Path, PathBuf};

/// Remove a file that may not exist. A missing file is fine (nothing to drop),
/// but any *other* error — a locked WAL, a permissions problem — is surfaced
/// loudly. Swallowing it would let the replay run into a surviving `index.db`
/// and silently duplicate every row (tool rows in particular are not deduped;
/// see `db::insert_message`).
fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("failed to remove {}", path.display())),
    }
}

/// As `remove_file_if_exists`, but for a directory tree.
fn remove_dir_all_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("failed to remove {}", path.display())),
    }
}

/// Clear the derived markdown mirror while preserving `imported/`.
///
/// The markdown dir is derived-from-raw and disposable — EXCEPT `imported/`,
/// which `chronicle migrate` copies out of the old ~/.claude-logs store. Those
/// legacy sessions have no raw archive to replay, so a blanket `remove_dir_all`
/// here would destroy them with no way to reconstruct them (which is exactly
/// what happened once — see the regression test in tests/layers.rs). Remove
/// every child of `markdown/` except `imported/`.
fn clear_derived_markdown(markdown_dir: &Path) -> Result<()> {
    let entries = match std::fs::read_dir(markdown_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(e).with_context(|| format!("reading {}", markdown_dir.display()));
        }
    };
    for entry in entries.flatten() {
        if entry.file_name() == "imported" {
            continue; // preserved legacy import — not derived from raw
        }
        let path = entry.path();
        if path.is_dir() {
            remove_dir_all_if_exists(&path)?;
        } else {
            remove_file_if_exists(&path)?;
        }
    }
    Ok(())
}

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

    // 1) Drop derived layers. A surviving index.db would be replayed into,
    //    duplicating rows — so fail loudly if it can't be removed.
    let db = store.index_db_path();
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{}", db.display(), suffix));
        remove_file_if_exists(&p)?;
    }
    clear_derived_markdown(&store.markdown_dir())?;

    // 2) Replay the raw archive through the derived layers only.
    let mut rebuild_cfg = cfg.clone();
    rebuild_cfg.layers.raw = false; // do not re-copy raw onto itself
    rebuild_cfg.watch_dirs = vec![store.raw_dir()];

    // Isolated, fresh offsets so the full raw archive is replayed every time.
    // A surviving offsets file would make the engine skip already-seen raw
    // files and replay nothing, so this removal must also fail loudly.
    let rebuild_offsets = store.state_dir().join("rebuild-offsets.json");
    remove_file_if_exists(&rebuild_offsets)?;
    let mut engine = Engine::new_with_offsets(rebuild_cfg, rebuild_offsets.clone())?;
    let n = engine.scan_all()?;
    // Best-effort cleanup of the scratch offsets: the rebuild has already
    // succeeded, and a leftover here is harmless because the next rebuild
    // removes it up front — so a failure must not fail the command.
    std::fs::remove_file(&rebuild_offsets).ok();
    Ok(n)
}
