//! Chronicle library crate — capture engine, storage layers, and subcommands.
//! The `chronicle` binary (src/main.rs) is a thin CLI over this crate, and the
//! integration tests in `tests/` exercise these modules directly.

pub mod config;
pub mod db;
pub mod jsonl;
pub mod store;
pub mod time;

pub mod capture;
pub mod commands;
pub mod layers;
