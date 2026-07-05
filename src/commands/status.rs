//! `chronicle status` — capture health (via the watchdog) plus recent sessions.

use crate::commands::watchdog::{evaluate_health, Health};
use crate::db::Index;
use anyhow::Result;
use clap::Args;
use std::path::PathBuf;

#[derive(Args)]
pub struct StatusArgs {
    #[arg(long)]
    store: Option<PathBuf>,
    #[arg(long, default_value_t = 10)]
    limit: usize,
    /// List only today's (local) sessions.
    #[arg(long)]
    today: bool,
}

pub fn run(args: StatusArgs) -> Result<()> {
    let cfg = super::load_config(args.store)?;
    let health = evaluate_health(&cfg);
    match &health {
        Health::Healthy { last_sync } => {
            println!("● capture healthy (last sync {last_sync})");
        }
        Health::Stale { last_sync, age_secs } => {
            println!("⚠ capture STALE — last sync {last_sync} ({age_secs}s ago). Is the daemon running?");
        }
        Health::Down { reason } => {
            println!("⚠ recorder NOT running — {reason}");
        }
    }

    let db_path = cfg.store_dir.join("index.db");
    if !db_path.exists() {
        println!("\nNo index yet.");
        return Ok(());
    }
    let index = Index::open(&db_path)?;
    println!("\nRecording {} session(s).", index.session_count()?);
    let sessions = if args.today {
        let (start, end) = crate::time::today_local_utc_bounds();
        index.sessions_in_range(&start, &end)?
    } else {
        index.recent_sessions(args.limit)?
    };

    let heading = if args.today { "Today's sessions" } else { "Recent sessions" };
    println!("\n{heading} ({}):", sessions.len());
    for s in sessions {
        let project = s.project_path.rsplit('/').next().unwrap_or(&s.project_path);
        // `message_count` counts indexed entries (a line can carry several), and
        // char-based truncation avoids ever slicing a non-ASCII id mid-codepoint.
        let short_id: String = s.id.chars().take(8).collect();
        println!("• {} — {} ({} entries) [{}]", s.started_at, project, s.message_count, short_id);
    }
    Ok(())
}
