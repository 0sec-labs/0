# Native offline snapshot facade

`SandboxExecutor::execute(SandboxRequest, CancellationToken, EventSink)` selects
exactly the requested Docker or smolvm backend. There is no fallback or pull.
The protocol's tagged backend retains Docker image references separately from
local microVM archive byte digests. Common snapshot, argv, build, stdin, timeout,
memory, CPU and output bounds match the original Docker snapshot-program path.
Fractional Docker CPUs remain supported; fractional microVM CPUs are rejected.
The default configs still require a qualified nonroot Linux host for each backend.

Docker delegates to its native executor and forwards live bounded stream events.
Smolvm uses the pinned 1.14.6 batch adapter, an existing local archive, and a
private source copy whose paths/content are verified against SnapshotPin before
mounting read-only. A guest shell copies that source into a disposable `/tmp`
working directory, runs an optional build with stdout redirected to stderr,
and execs literal-quoted argv. Source integrity is rechecked after execution.
It does not give the guest direct access to the authorized original source.

The deadline includes snapshot setup; cleanup and integrity recheck have their
own bounded finalization windows. Dropping the facade future cancels an owned
task which retains snapshot ownership through backend cleanup while Tokio lives.
Staged source is removed only after confirmed teardown or no guest creation.
Uncertain VM cleanup retains both runtime and snapshot recovery paths; unexpected
abandonment retains staged data. Startup reconciliation remains unimplemented.

MicroVM output events are **buffered until completion**, emitted in bounded
chunks, and do not include a fabricated Started event. Docker events are live.
Final results retain complete raw streams up to their caps independently of
callback success; callbacks must not block. JSON transports use base64 strings,
including the low-level microVM request/result types now in zero-protocol.
Artifact metadata on failed executions identifies the requested artifact, not
proof that guest code ran. Cleanup refs are explicitly backend-specific.

Default tests cover Docker delegation, rejection before fallback, shared byte
schemas and staging ownership. The fake microVM facade test additionally
requires host KVM qualification (the production host check is not bypassed).
The ignored real test uses `ZERO_SMOLVM_SMOKE_ARCHIVE` pointing at an existing
Node archive. It verifies read-only source, private guest workdir, build, literal
argv, stdin, nonroot identity, unchanged original source and confirmed cleanup.
No downloads or device permission changes are performed by tests.
