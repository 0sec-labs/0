# Native 0sec rewrite

Integration branch: `the-great-rust-rewrite`.

This is an experimental implementation, not a replacement release. Native crates
currently provide a versioned JSON protocol, SQLite session journal and budget
ledger, single-owner engine, offline Docker snapshot execution, source-preserving
finding reconciliation, a qualified-profile smolvm batch adapter, Responses
inference with durable accounting, and a CLI with an NDJSON app-server. Production scan commands,
remaining provider adapters, agent orchestration, evolution integration and TUI
are still migration work. Unsupported legacy commands fail explicitly.

The destination is the native CLI and engine described in the
[architecture and migration plan](../docs/design/2026-09-18-native-harness-architecture.md).
The [execution design](EXECUTION-DESIGN.md) documents existing behavior and
qualification requirements. The draft protocol is not yet a compatibility promise.

From this directory:

```sh
cargo fmt --all --check
cargo test --workspace --locked
cargo run --locked -p zero-cli -- --help
cargo run --locked -p zero-cli -- schema
cargo run --locked -p zero-cli -- --state /tmp/0sec-native-example.db session create --generation baseline --budget-limit 100
```

Native state defaults to `.0sec/native/state.db`, separate from legacy state.
One engine owns a database at a time. Completed command retries return persisted
results; interrupted effects become unknown on recovery and are never silently
repeated. Explicit shutdown waits for cancellation and cleanup. Process death
still requires backend-specific external resource recovery; Rust destructors
cannot guarantee cleanup after SIGKILL.

Docker execution accepts an explicitly pinned source snapshot and an already
local image. It does not pull images or fall back to execution on the host.
An opt-in real Docker test checks isolation and cancellation; it requires a local
Node image and is skipped by the default suite. See its source for configuration.

Keep one owner for shared protocol changes and Cargo.lock. Production TypeScript
commands remain the behavioral reference during migration. Release defaults and
cloud images change only after the relevant parity gates.
