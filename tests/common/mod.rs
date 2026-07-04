//! Shared test helpers. Each `tests/*.rs` compiles this module separately, so
//! some helpers are unused in some crates — hence the blanket allow.
#![allow(dead_code)]

use chronicle::config::{CaptureMode, Config, Layers, SummaryConfig};
use std::path::PathBuf;

/// Build a Config wired to temp `store` and `watch` dirs with chosen layers.
pub fn test_config(store: PathBuf, watch: PathBuf, layers: Layers) -> Config {
    Config {
        enabled: true,
        store_dir: store,
        watch_dirs: vec![watch],
        layers,
        capture: CaptureMode::Live,
        summaries: SummaryConfig { enabled: false },
        exclude_projects: Vec::new(),
        exclude_tools: Vec::new(),
        max_tool_output_length: 2000,
        index_debounce_ms: 0,
        staleness_secs: 7200,
        debug: false,
    }
}

pub fn all_layers() -> Layers {
    Layers { raw: true, markdown: true, sqlite: true }
}

/// A minimal but realistic Claude transcript line.
pub fn line(session: &str, cwd: &str, role: &str, text: &str) -> String {
    let uuid = format!("{session}-{text}");
    format!(
        r#"{{"type":"{role}","uuid":"{uuid}","sessionId":"{session}","cwd":"{cwd}","timestamp":"2026-07-04T10:00:00Z","message":{{"role":"{role}","content":"{text}"}}}}"#,
    )
}
