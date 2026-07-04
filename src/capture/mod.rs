//! Capture engine and its triggers.
//!
//! One shared [`engine::Engine`] performs all capture work; the *trigger*
//! (live filesystem-watch or periodic poll) merely decides when to call it.

pub mod engine;
pub mod offset;
pub mod poll;
pub mod watch;

pub use engine::Engine;
