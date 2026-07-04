//! Periodic-poll trigger (fallback). Used where filesystem-watch APIs are
//! unavailable or restricted. Because normal compaction is append-only, a
//! seconds-scale poll interval loses nothing relative to live mode and still
//! comfortably beats Claude Code's retention deletion (which acts over days).

use crate::capture::Engine;
use anyhow::Result;
use std::time::Duration;

pub fn run(mut engine: Engine, interval_ms: u64) -> Result<()> {
    let interval = Duration::from_millis(interval_ms.max(200));
    eprintln!("[chronicle] poll capture started; interval {interval_ms}ms");
    loop {
        if let Err(e) = engine.scan_all() {
            eprintln!("[chronicle] scan error: {e}");
        }
        engine.touch_heartbeat().ok();
        std::thread::sleep(interval);
    }
}
