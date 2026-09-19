//! Explicit host-side consumption of exported workspace changes.
//! Content integrity does not establish test success or production eligibility.
mod bundle;
#[cfg(target_os = "linux")]
mod metadata;
pub use bundle::{Bundle, Change, FileState, hash};
#[cfg(unix)]
mod filesystem;
#[cfg(unix)]
pub use filesystem::{Preflight, preflight};
#[cfg(target_os = "linux")]
mod application;
#[cfg(target_os = "linux")]
pub use application::{ApplyStatus, apply, inspect_application, rollback};
