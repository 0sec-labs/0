# Native 0sec rewrite

Integration branch: `the-great-rust-rewrite`.

This is an experimental implementation, not a replacement release. Native crates
currently provide a versioned JSON protocol, SQLite session journal and budget
ledger, single-owner engine, offline Docker snapshot execution, source-preserving
finding reconciliation, explicit Docker/smolvm snapshot backends, Responses/Chat/Anthropic Messages
inference with durable accounting, a bounded offline snapshot agent, and a CLI
with an NDJSON app-server. Production scan commands, remaining provider adapters,
full agent orchestration, evolution integration and TUI
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

Sandbox requests select Docker or smolvm explicitly; failed prerequisites never
select a different backend. Both use verified private snapshot staging and the
same durable operation, cancellation and retry semantics. The smolvm profile
requires Linux/KVM, the qualified runtime, and a prepared local archive. Guest
output is buffered until completion. Its opt-in engine integration test exercises
a real two-turn agent using a loopback provider fixture, not paid inference.

App-server clients receive an `admitted` event with operation/session/command and
execution IDs once a new effect has durable ownership. Wait for this event before
cancelling an asynchronously submitted command. It is not proof that a process or
provider request has started. Cancellation known to precede provider dispatch
releases the reservation at zero charge; uncertain remote outcomes retain it.

Agent requests may set `continuation_of` to a completed agent operation ID in the
same session. The engine restores the last persisted provider input and complete
replay, including previous tool results, before appending the new prompt. It
requires the same model, provider route/rates, instructions and pinned execution
profile. Omitting the field starts a fresh history; selecting an earlier completed
operation explicitly branches. Unknown/interrupted operations cannot be continued
through this path, and no prior effect is reissued. History is reconstructed from already durable records rather than duplicated.
Journal schema v3 adds optional activation epochs for generation-bound sessions;
v1/v2 sessions migrate without inventing an activation pin. Host operation details
retain pre-dispatch recovery identities and post-settlement lease release evidence.

Journal schema v4 retains immutable source/plan/evidence artifacts with owner-bound
operation attachments. Attachment bytes and the hash-only event commit atomically;
ordinary event streams do not expose source bytes. Reads recheck content identity.

The native CI workflow tests the declared minimum Rust 1.85.0 and stable on Linux,
builds the experimental executable, and checks formatting/production lints. The
lockfile pins `yoke-derive` 0.8.2: 0.8.3 uses `str::from_utf8`, which failed an
actual 1.85.0 build despite dependency metadata allowing its selection. Preserve
this pin until the minimum-toolchain job demonstrates an upgrade works. Default
CI uses deterministic subprocess/loopback fixtures; opt-in Docker/smolvm tests
still require separately prepared local runtimes and images. CI does not publish
or replace the production TypeScript CLI.
