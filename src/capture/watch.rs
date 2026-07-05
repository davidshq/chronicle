//! Live filesystem-watch trigger (default). Lightest at idle: the thread
//! blocks on the OS notification channel and does nothing until a transcript
//! file is created or written.

use crate::capture::Engine;
use anyhow::Result;
use notify::{RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

/// How often, at idle, the daemon proves liveness by ticking the heartbeat.
/// Kept well under the default `staleness_secs` (7200s) so a healthy but idle
/// daemon never drifts into the watchdog's stale window.
const HEARTBEAT_TICK: Duration = Duration::from_secs(60);

pub fn run(mut engine: Engine, watch_dirs: &[std::path::PathBuf]) -> Result<()> {
    // Capture anything already present before we start watching.
    engine.scan_all()?;
    engine.touch_heartbeat()?;

    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })?;

    for dir in watch_dirs {
        // The projects dir may not exist yet on a fresh machine; create it so
        // the watch attaches and we pick up sessions as soon as they appear.
        std::fs::create_dir_all(dir).ok();
        if let Err(e) = watcher.watch(dir, RecursiveMode::Recursive) {
            eprintln!("[chronicle] warning: cannot watch {}: {e}", dir.display());
        }
    }

    eprintln!("[chronicle] live capture started; watching {} dir(s)", watch_dirs.len());

    // Block for filesystem events, but wake on a timer when idle so the daemon
    // proves liveness independently of capture activity. Because the tick shares
    // this thread with `sync_file`, a genuinely wedged capture loop won't tick —
    // exactly the failure the watchdog exists to catch.
    loop {
        match rx.recv_timeout(HEARTBEAT_TICK) {
            Ok(Ok(event)) => {
                let mut captured = false;
                for path in event.paths {
                    if is_jsonl(&path) {
                        match engine.sync_file(&path) {
                            Ok(n) if n > 0 => captured = true,
                            Ok(_) => {}
                            Err(e) => eprintln!("[chronicle] sync error {}: {e}", path.display()),
                        }
                    }
                }
                if captured {
                    engine.touch_heartbeat().ok();
                }
            }
            Ok(Err(e)) => eprintln!("[chronicle] watch error: {e}"),
            Err(RecvTimeoutError::Timeout) => {
                // Idle interval elapsed. Before refreshing liveness, do a full
                // reconciling scan as a safety net: `notify` can coalesce or drop
                // events under load, and the last write to a since-idle file would
                // otherwise stay uncaptured until its next event or a daemon
                // restart. The scan is cheap — every up-to-date file short-circuits
                // on the offset check in `sync_file` — and `scan_all` bumps
                // `last_sync` itself if it captures anything.
                if let Err(e) = engine.scan_all() {
                    eprintln!("[chronicle] periodic scan error: {e}");
                }
                engine.tick_heartbeat().ok();
            }
            // The watcher was dropped and the channel closed: nothing more to do.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

fn is_jsonl(path: &Path) -> bool {
    path.extension().map(|e| e == "jsonl").unwrap_or(false)
}
