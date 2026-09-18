# Native 0sec rewrite

Integration branch: `the-great-rust-rewrite`.

This is an experimental foundation, not a replacement release. The only current
crate is `zero-protocol`: draft serialized values, JSON Schema generation and
input-validation tests. No engine, executor or CLI binary is implemented here.

The destination is the native CLI and engine described in the
[architecture and migration plan](../docs/design/2026-09-18-native-harness-architecture.md).
The [execution design](EXECUTION-DESIGN.md) documents existing behavior and
qualification requirements. The draft types are not yet a compatibility promise.

From this directory:

```sh
cargo fmt --all --check
cargo test --workspace --locked
```

Keep one owner for shared protocol changes and Cargo.lock. Independent module
work should use topic branches and worktrees from the integration branch.
Production TypeScript commands remain the behavioral reference during migration.
Release defaults and cloud images change only after the relevant parity gates.
