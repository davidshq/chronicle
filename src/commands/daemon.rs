//! `chronicle daemon` — the always-on capture service (a.k.a. `chronicled`).

use crate::capture::{poll, watch, Engine};
use crate::config::CaptureMode;
use anyhow::Result;
use clap::Args;
use std::path::PathBuf;

#[derive(Args)]
pub struct DaemonArgs {
    /// Override the store directory (defaults to ~/.chronicle or config).
    #[arg(long)]
    store: Option<PathBuf>,
    /// Force periodic-poll capture instead of the configured/live default.
    #[arg(long)]
    poll: bool,
    /// Poll interval in milliseconds (with --poll).
    #[arg(long, default_value_t = 2000)]
    poll_interval_ms: u64,
    /// Capture everything once and exit (no watching). Useful for testing/cron.
    #[arg(long)]
    once: bool,
}

pub fn run(args: DaemonArgs) -> Result<()> {
    let cfg = super::load_config(args.store)?;
    if !cfg.enabled {
        eprintln!("[chronicle] disabled by config (enabled=false); idling exit.");
        return Ok(());
    }
    let watch_dirs = cfg.watch_dirs.clone();
    let mode = cfg.capture.clone();
    let mut engine = Engine::new(cfg)?;

    if args.once {
        let n = engine.scan_all()?;
        engine.touch_heartbeat()?;
        println!("Captured {n} line(s).");
        return Ok(());
    }

    if args.poll {
        return poll::run(engine, args.poll_interval_ms);
    }
    match mode {
        CaptureMode::Poll { interval_ms } => poll::run(engine, interval_ms),
        CaptureMode::Live => watch::run(engine, &watch_dirs),
    }
}
