//! `chronicle watchdog` — liveness + staleness check for the plugin.
//!
//! This is invoked from a Claude Code hook. It is deliberately **non-destructive
//! and always exits 0**: a monitoring failure must never affect capture (which
//! runs in the separate daemon) — the worst case is a missed warning.

use crate::config::Config;
use crate::store::{process_alive, Heartbeat, Store};
use anyhow::Result;
use clap::Args;
use std::path::PathBuf;

#[derive(Args)]
pub struct WatchdogArgs {
    #[arg(long)]
    store: Option<PathBuf>,
    #[arg(long)]
    json: bool,
}

pub enum Health {
    Healthy { last_sync: String },
    Stale { last_sync: String, age_secs: i64 },
    Down { reason: String },
}

/// Evaluate capture health from the heartbeat file and process liveness.
pub fn evaluate_health(cfg: &Config) -> Health {
    let store = Store::new(cfg.store_dir.clone());
    let hb = match Heartbeat::read(&store.heartbeat_path()) {
        Ok(Some(hb)) => hb,
        Ok(None) => {
            return Health::Down { reason: "no heartbeat found (daemon has never run)".into() }
        }
        Err(e) => return Health::Down { reason: format!("unreadable heartbeat: {e}") },
    };

    if !process_alive(hb.pid) {
        return Health::Down { reason: format!("daemon process {} is not alive", hb.pid) };
    }

    match chrono::DateTime::parse_from_rfc3339(&hb.last_sync) {
        Ok(ts) => {
            let age = chrono::Utc::now().signed_duration_since(ts.with_timezone(&chrono::Utc));
            let age_secs = age.num_seconds();
            if age_secs > cfg.staleness_secs as i64 {
                Health::Stale { last_sync: hb.last_sync, age_secs }
            } else {
                Health::Healthy { last_sync: hb.last_sync }
            }
        }
        Err(_) => Health::Healthy { last_sync: hb.last_sync },
    }
}

pub fn run(args: WatchdogArgs) -> Result<()> {
    // Never fail loudly: any error resolves to a benign default report.
    let cfg = super::load_config(args.store).unwrap_or_default();
    let health = evaluate_health(&cfg);

    if args.json {
        let v = match &health {
            Health::Healthy { last_sync } => {
                serde_json::json!({ "status": "healthy", "last_sync": last_sync })
            }
            Health::Stale { last_sync, age_secs } => {
                serde_json::json!({ "status": "stale", "last_sync": last_sync, "age_secs": age_secs })
            }
            Health::Down { reason } => {
                serde_json::json!({ "status": "down", "reason": reason })
            }
        };
        println!("{}", serde_json::to_string(&v)?);
    } else {
        match &health {
            Health::Healthy { .. } => {}
            Health::Stale { age_secs, .. } => {
                eprintln!("⚠ Chronicle: recorder hasn't synced in {}s — the DB may not be updating. Is the daemon running?", age_secs);
            }
            Health::Down { reason } => {
                eprintln!("⚠ Chronicle: recorder not running ({reason}). Sessions are NOT being captured.");
            }
        }
    }
    // Always succeed — monitoring is non-destructive to capture.
    Ok(())
}
