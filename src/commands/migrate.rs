//! `chronicle migrate` — import an existing ~/.claude-logs store.
//!
//! The old hook-based plugin (`claude-remember`) wrote markdown + a SQLite db
//! under ~/.claude-logs. Those may reference sessions Claude Code has since
//! deleted, so we preserve them under the Chronicle store rather than lose them.
//! Going forward, fresh capture comes from the daemon reading ~/.claude/projects.

use crate::config::Config;
use crate::store::Store;
use anyhow::Result;
use clap::Args;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Args)]
pub struct MigrateArgs {
    /// Old log directory (defaults to ~/.claude-logs or the old config's logDir).
    #[arg(long)]
    from: Option<PathBuf>,
    #[arg(long)]
    store: Option<PathBuf>,
}

pub fn run(args: MigrateArgs) -> Result<()> {
    let cfg = super::load_config(args.store)?;
    let store = Store::new(cfg.store_dir.clone());
    store.ensure_dirs()?;

    let old_dir = args.from.unwrap_or_else(default_old_log_dir);
    if !old_dir.exists() {
        println!("Nothing to migrate: {} does not exist.", old_dir.display());
        maybe_write_config(&cfg)?;
        return Ok(());
    }

    // 1) Preserve old markdown sessions under markdown/imported/.
    let old_sessions = old_dir.join("sessions");
    let dest = store.markdown_dir().join("imported");
    let mut md_count = 0usize;
    if old_sessions.exists() {
        md_count = copy_tree(&old_sessions, &dest)?;
    }

    // 2) Preserve the legacy SQLite db for reference.
    let old_db = old_dir.join("sessions.db");
    let mut db_copied = false;
    if old_db.exists() {
        let legacy = store.root.join("legacy-sessions.db");
        std::fs::copy(&old_db, &legacy)?;
        db_copied = true;
    }

    maybe_write_config(&cfg)?;

    println!("Migration complete:");
    println!("  • {md_count} markdown file(s) imported → {}", dest.display());
    if db_copied {
        println!("  • legacy SQLite db preserved → {}", store.root.join("legacy-sessions.db").display());
    }
    println!("  • Run `chronicle daemon` to begin live capture from ~/.claude/projects.");
    Ok(())
}

fn maybe_write_config(cfg: &Config) -> Result<()> {
    let path = Config::config_path(&cfg.store_dir);
    if !path.exists() {
        cfg.save()?;
        println!("  • wrote default config → {}", path.display());
    }
    Ok(())
}

fn default_old_log_dir() -> PathBuf {
    // Honor the old config's logDir if present, else ~/.claude-logs.
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let default = home.join(".claude-logs");
    let old_cfg = default.join("config.json");
    if let Ok(text) = std::fs::read_to_string(&old_cfg) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(dir) = v.get("logDir").and_then(|d| d.as_str()) {
                return PathBuf::from(shellexpand_tilde(dir));
            }
        }
    }
    default
}

fn shellexpand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_string()
}

/// Recursively copy `src` into `dst`, returning the number of files copied.
fn copy_tree(src: &Path, dst: &Path) -> Result<usize> {
    let mut count = 0;
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            count += copy_tree(&path, &target)?;
        } else {
            std::fs::copy(&path, &target)?;
            count += 1;
        }
    }
    Ok(count)
}
