# Offline single-call plugin runner

This crate executes an already admitted, generation-pinned plugin call through
`zero-sandbox`. It is not a general plugin broker, marketplace loader, model
runtime, or TypeScript plugin-protocol compatibility layer. Guest replies remain
untrusted data and never authorize host calls.

## Explicit launch contract

The selected manifest's `entrypoint.argv` must begin with the literal string
`{artifact}`. That first argument becomes
`./plugins/<manifest-digest>/artifacts/<artifact-digest>` inside the disposable
snapshot. Every later manifest argument is passed literally, with no placeholder
or shell expansion. The host supplies a fixed interpreter prefix (for example
`["node"]`), backend, timeout, memory, CPU and output limits. Guest input and
output cannot change those settings. There are no image pulls or host/backend
fallbacks. An incompatible interpreter/image fails explicitly.

The private source snapshot contains canonical manifests and reverified artifact
bytes for the selected plugin and all pinned transitive dependencies. Paths use
manifest digests, not plugin IDs. `plugins.json` maps IDs to those digest folders.
No host source tree or credentials are added. `zero-sandbox` copies this verified
snapshot into a writable disposable guest workspace and enforces its offline
backend contract; guest filesystem mutations do not update source artifacts.

The runner checks the still-issued `PinnedCall`, selected manifest digest,
dependency identities/versions and declaration closure. Only `compute`,
`process-exec`, `filesystem-read` and `filesystem-write` are accepted, and only
inside this offline disposable environment. Any selected/dependency manifest
with network, model-call or findings-write capability rejects before launch.
This deliberately also rejects otherwise unused privileged tools in those
manifests. Coarse capability declarations cannot attest that arbitrary code is
honest; actual confinement remains the sandbox backend's responsibility.

## One request, one untrusted response

Stdin is exactly one native JSON-RPC 2.0 `tool.invoke` request, ID 1, containing
only the selected tool name and validated input. Stdout must contain exactly one
bounded newline-terminated `result` or `error` frame with ID 1. Extra frames,
callbacks, notifications, wrong IDs, malformed/truncated JSON and oversized
frames/results reject. Stderr is raw diagnostic output, never another protocol
channel. A parsed guest error is explicitly `UntrustedReply::Error`.

An accepted reply additionally requires exit code zero, normal process exit and
confirmed/not-created sandbox cleanup. Every outcome retains the raw bounded
sandbox result when execution was attempted, including rejected output. There is
no bidirectional dispatch, request multiplexing or provider call path.

## Ownership and durable lease settlement

`Runner::start` consumes a non-deserializable `PinnedCall`. A rejected start
returns it with the error. A successful start returns `RunningCall`; the owned
worker retains the call and source staging until backend settlement. Dropping
the running handle or its wait future requests cancellation but does not abort
the owning lifecycle task. This requires the Tokio runtime to remain alive and
drain tasks; abrupt process/runtime death is not graceful cleanup.

Source staging is kept before launch and removed only following confirmed cleanup
(or a failure before backend creation). Uncertain cleanup or staging deletion
failure leaves `Outcome::staging_recovery`. A supervisor panic also leaves staging
rather than deleting a tree a detached backend may still use. Record
`RunningCall::staging_path()` before waiting if supervisor failure recovery needs
that path; directory names also contain the durable lease ID.

No path auto-releases a generation lease. On success, the host checks
`Outcome::backend_settled()`, validates any remaining broker work is settled, then
calls `Harness::complete_settled(&mut outcome.call)`. On unknown cleanup, do not
release. Dropped/lost outcomes leave durable leases discoverable via the harness;
the supervisor must establish fencing/quiescence before explicit recovery.

## Validation

Five default tests use a fake Docker launcher, not an isolation oracle. They cover
fixed request and literal argv, frame rejection, capability/stale-handle denial,
uncertain cleanup and dropping a waiter during a running subprocess.

The opt-in `real_offline_node_plugin` test ran successfully against the already
installed `node:24-alpine` image
`sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81`.
It executes only an embedded fixture, reads stdin, emits one response, verifies
nonroot UID and literal arguments, and confirms cleanup. No image was pulled.
This qualifies that local Docker path, not every image/platform or the smolvm
plugin path.

```sh
cargo test -p zero-plugin-runner
cargo test -p zero-plugin-runner --test runner real_offline_node_plugin -- --ignored --exact
```
