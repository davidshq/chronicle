//! Subcommand implementations. Each `run` is invoked from `main`.

pub mod daemon;
pub mod migrate;
pub mod rebuild;
pub mod search;
pub mod status;
pub mod watchdog;

use crate::config::Config;
use anyhow::Result;
use std::path::PathBuf;

/// Current UTC time as an RFC3339 string (used for heartbeat/started_at).
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Today's local calendar date as YYYY-MM-DD (used by `today` listing).
pub fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Shared config loading honoring an optional `--store` override.
pub fn load_config(store: Option<PathBuf>) -> Result<Config> {
    Config::load(store)
}
