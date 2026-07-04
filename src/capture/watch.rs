//! Live filesystem-watch trigger (default). Lightest at idle: the thread
//! blocks on the OS notification channel and does nothing until a transcript
//! file is created or written.

use crate::capture::Engine;
use anyhow::Result;
use notify::{RecursiveMode, Watcher};
use std::path::Path;

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

    for res in rx {
        match res {
            Ok(event) => {
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
            Err(e) => eprintln!("[chronicle] watch error: {e}"),
        }
    }
    Ok(())
}

fn is_jsonl(path: &Path) -> bool {
    path.extension().map(|e| e == "jsonl").unwrap_or(false)
}
