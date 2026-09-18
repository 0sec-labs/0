//! Scoped target HTTP with owned DNS/TLS sockets and explicit durable admission.
mod auth;
mod client;
mod clock;
mod dns;
mod policy;
mod transport;
mod types;
pub use auth::StaticAuth;
pub use client::{Client, canonical_origin, normalize_intent, normalize_policy, profile_sha256};
pub use clock::{Clock, MonotonicClock};
pub use dns::{OwnedDns, Resolver};
pub use types::*;
