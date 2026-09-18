# Native smolvm batch execution

A separate backend primitive; it is not wired into the native application
protocol or a replacement for Docker's snapshot-program executor yet.
`execute(SmolvmRequest, SmolvmConfig, CancellationToken)` requires non-root Linux,
usable `/dev/kvm`, `setpriv` and the complete smolvm **1.14.6** bundle.

Requests pin the SHA-256 of an existing local archive. It is copied and hashed
into private state before launch. Guest execution is offline, unprivileged
UID/GID 1000, with explicit read-only directory mounts and bounded raw streams.
Mounts are host-authorized paths, **not SnapshotPin attestations**. No image pull,
host fallback, runtime installation or automatic group change occurs.

The caller owns execution configuration. Dropping/cancelling its future signals
an independent task which kills the launcher process group and awaits runtime
teardown while Tokio remains alive. `setpriv` and smolvm's foreground watchdog
cover parent death; ordinary completion additionally checks `/proc` for remaining
owned runtime processes. The launcher stays unreaped until its process-group
signal authority is consumed, preventing stale PID reuse. Failed inspection of
same-UID processes makes teardown unconfirmed and retains private recovery state.
Stopping the entire Tokio runtime is distinct from dropping one caller; startup
reconciliation is not implemented in this crate.

Tests exercise a fake launcher for profile argv, private environment, literal
input, binary output, nonzero exit, invalid version/banner, archive identity and
symlinks, deadlines, inherited descendant pipes, cancellation, output overflow
and caller drop. They do not prove hypervisor isolation.

A real smoke using the already prepared Node archive passed on 2026-09-18:
archive SHA-256 `2bda0b195b4a451d7e3c516a2c08178024f4407e60e7abfed831eb5f06444c48`,
UID/GID 1000, supplied stdin, absent provider credential and Docker socket,
exit 0 and confirmed cleanup. The current shell needed `sg kvm` to activate its
already granted group membership; no device permissions were changed.

```sh
cargo test -p zero-smolvm
cargo build -p zero-smolvm --example smoke
# Only when the account is already a member and the current shell is stale:
sg kvm -c '/absolute/path/to/target/debug/examples/smoke /prepared/node.tar'
```

This is narrow batch smoke evidence, not full backend qualification. Real
network denial, read-only mount behavior, resource exhaustion, cancellation,
SIGKILL teardown, interactive plugins and all toolbox commands still need native
qualification. No startup performance ranking is claimed.
