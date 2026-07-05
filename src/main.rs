//! Chronicle — an external, lossless recorder for Claude Code sessions.
//!
//! A single binary with git-style subcommands serving two roles:
//!   * `chronicle daemon`   — the always-on capture service (a.k.a. `chronicled`)
//!   * `chronicle search`   — plugin: FTS query over the store
//!   * `chronicle status`   — plugin: capture health + recent sessions
//!   * `chronicle watchdog` — plugin: hook-invoked liveness/staleness check
//!   * `chronicle migrate`  — one-time import from the old ~/.claude-logs store

use chronicle::commands;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "chronicle",
    version,
    about = "Lossless recorder for Claude Code sessions (raw JSONL + markdown + SQLite/FTS)."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the capture daemon (watches Claude Code transcripts and records them).
    Daemon(commands::daemon::DaemonArgs),
    /// Full-text search over captured sessions.
    Search(commands::search::SearchArgs),
    /// Show capture health and recent sessions.
    Status(commands::status::StatusArgs),
    /// Check daemon liveness / store freshness (invoked by the plugin hook).
    Watchdog(commands::watchdog::WatchdogArgs),
    /// Import an existing ~/.claude-logs store into Chronicle.
    Migrate(commands::migrate::MigrateArgs),
    /// Rebuild derived layers (markdown, index) from the raw archive.
    Rebuild(commands::rebuild::RebuildArgs),
}

/// Restore the default `SIGPIPE` disposition. Rust ignores `SIGPIPE` by default,
/// which turns writes to a closed pipe into `EPIPE` errors that make `println!`
/// panic — so `chronicle search … | head` would panic with a backtrace instead
/// of exiting quietly. Resetting to `SIG_DFL` makes such a broken pipe terminate
/// the process silently, the conventional CLI behavior.
#[cfg(unix)]
fn reset_sigpipe() {
    const SIGPIPE: i32 = 13; // same value on Linux and macOS
    const SIG_DFL: usize = 0;
    // SAFETY: setting a signal disposition to the default handler is safe and is
    // done once before any I/O; mirrors the hand-rolled libc binding in store.rs.
    unsafe {
        extern "C" {
            fn signal(signum: i32, handler: usize) -> usize;
        }
        signal(SIGPIPE, SIG_DFL);
    }
}

#[cfg(not(unix))]
fn reset_sigpipe() {}

fn main() -> anyhow::Result<()> {
    reset_sigpipe();
    let cli = Cli::parse();
    match cli.command {
        Command::Daemon(args) => commands::daemon::run(args),
        Command::Search(args) => commands::search::run(args),
        Command::Status(args) => commands::status::run(args),
        Command::Watchdog(args) => commands::watchdog::run(args),
        Command::Migrate(args) => commands::migrate::run(args),
        Command::Rebuild(args) => commands::rebuild::run(args),
    }
}
