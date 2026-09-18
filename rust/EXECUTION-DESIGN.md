# Native execution migration design

Status: proposed implementation contract, 2026-09-18. No Rust execution backend
is implemented or qualified by this document. Public CLI syntax and any RPC
transport remain coordinator decisions. Types below describe internal semantics.

## First complete path

Implement one-shot, offline Docker snapshot execution end to end. A real native
caller supplies an immutable source snapshot, local image selection, command,
optional build command, finite JSON input, and resource limits. Rust validates
and resolves these, creates and supervises the container, returns bounded output,
verifies cleanup and source integrity, and exposes the result to that caller.
Calling the existing JavaScript CLI does not implement this path.

Initial qualification: nonroot Linux with the operator's existing Docker CLI and
daemon configuration. Unsupported platforms/backends must return explicit errors.
This establishes snapshot-program execution, not agent-loop, plugin, or CLI parity.
The Docker CLI is an infrastructure dependency, just as a VM launcher is; it is
not a fallback to the legacy engine. Retaining it initially also preserves Docker
contexts and TLS configuration without adding a second daemon client policy.

Sources: `packages/core/src/improvement/{types,config,registry,sandbox}.ts`,
`packages/core/src/runtime/{interactive,smolvm}.ts`.

## Coverage inventory

| Existing surface | Required semantics | Migration status/sequence |
| --- | --- | --- |
| Evolution Docker snapshot | Immutable local image, snapshot validation, build then command, stdin JSON, nonroot/networkless execution, resource limits, bounded streams, cleanup | First complete path |
| Docker access recovery | Respect remote/custom contexts; refresh only already-granted local socket group membership through `sg`; kill supervisor descendants | Include before claiming existing Docker backend parity |
| Interactive executable plugins | Bidirectional stdio, partial JSON framing, initial input, lifecycle cancellation, host protocol authorization | Later; batch completion is not plugin parity |
| smolvm snapshot | Nonroot Linux/KVM/setpriv, exact qualified version, archive-byte identity, private runtime state, read-only mounts, watchdog and verified teardown | Separate backend qualification |
| Ordinary agent Bash | Host execution, sanitized environment, grace period then group kill, output policy, tool scope and approval checks | Separate host profile, never advertised as isolation |
| Restricted `run_command` | Existing token/argv and scope policy plus local process lifecycle | Separate tool adapter |
| Replay Docker | Writable evidence directory, supported action translation, separately authorized HTTP networking, cidfile cleanup, evidence artifacts | Separate policy and integration |
| Replay/QEMU/kernel runners | VM artifacts, kernel-specific execution/reproduction oracles, teardown and evidence | Separate backend and domain adapters |
| npm dynamic detector harness | Node realm executes package detectors; local tempdir provider or injected remote provider | Keep Node guest dependency; do not confuse realm separation with OS sandboxing |
| External model CLIs/MCP | Provider-specific stream parsing, auth homes, current executable/MCP launch identity, usage and cancellation | Control-plane provider integration, not guest execution |

Relevant extra sources: `agent/tools.ts`, `agent/sanitized-env.ts`,
`verify/replay-runner.ts`, `stages/npm-detectors/sandbox-probe.ts`,
`runtime/{process,cli-native,codex-home}.ts`, `triage/kernel-vm-runner.ts`.

## Proposed internal Rust types

```rust
// Constructors validate invariants; fields need not be publicly constructible.
struct ExecutionId(Uuid); // allocated by controller, never from guest stdout
struct Sha256([u8; 32]);
struct Argv(Vec<String>); // nonempty executable, no NUL, existing config bounds
struct SnapshotFile { path: RelativePath, digest: Sha256, bytes: u64 }
struct VerifiedSnapshot { id: String, root: PathBuf, digest: Sha256,
                          files: Vec<SnapshotFile> }
struct Limits { timeout: Duration, memory_mib: u32, cpus: f64,
                max_stdout_bytes: usize, max_stderr_bytes: usize }
enum ImageSelection { LocalDockerReference(String), DockerId(Sha256) }
struct OfflineSnapshotRequest {
    id: ExecutionId,
    snapshot: VerifiedSnapshot,
    image: ImageSelection,
    build: Option<Argv>,
    command: Argv,
    input: serde_json::Value,
    limits: Limits,
}
enum StopReason { Exited, Cancelled, Deadline, OutputLimit, LaunchFailed,
                  ControlFailed, SnapshotChanged }
enum CleanupStatus { Confirmed, NotCreated, Unconfirmed { recovery_id: String } }
struct ExecutionResult {
    id: ExecutionId,
    exit_code: Option<i32>,
    stdout: Vec<u8>, stderr: Vec<u8>,
    elapsed: Duration,
    reason: StopReason,
    cleanup: CleanupStatus,
    diagnostics: Vec<ExecutionDiagnostic>,
}
enum ExecutionEvent {
    Accepted { id: ExecutionId },
    Attached { id: ExecutionId },
    Output { id: ExecutionId, stream: Stream, sequence: u64, bytes: Vec<u8> },
    Finished(ExecutionResult),
}
```

These are batch-only types. Do not expose unsupported interactive stdin messages
yet. Later transport can frame binary streams or explicitly encode bytes; never
assume a read chunk is complete UTF-8 or one JSON message. `Attached` means the
transport was attached, not application protocol readiness. Stream sequence is
delivery order, not a reconstruction of causal ordering between two OS pipes.

Cancellation is a controller-owned token passed separately to execution. A later
IPC cancellation message may refer only to a controller-owned execution ID.
Deadline and cancellation must remain distinct. A child exit of zero with
unconfirmed cleanup or changed snapshot is not a successful execution.
Keep primary failure and cleanup diagnostics separately; cleanup must not erase
the reason execution stopped. Capture raw bytes and render text at presentation.

Existing config bounds: timeout 100–600000 ms, memory 32–16384 MiB, Docker CPU
allocation finite and positive up to 16, output cap 256–16777216 bytes per stream.
smolvm later requires integer CPUs. Existing argv has 1–128 entries of at most
8192 characters. Do not silently round fractional Docker CPUs to integer counts.
Snapshot hashing/canonical JSON must use existing compatible bytes, with golden
vectors for JSON escaping, numeric representation and key order; do not assume
Serde's default serialization equals JavaScript's canonical serializer.

## Trusted controller and untrusted guest

The controller selects backend, image, source snapshot, limits and allowed tool
capabilities. Guest code receives only copied source and input. Guest output is
data: it cannot name a host PID to kill, select a mount, authorize a network
request, grant a provider credential, or declare itself verified.

For the first path, no generic arbitrary mount, Docker-option, host-environment,
or network-profile field is accepted. Mount only the verified snapshot read-only
at `/snapshot`; copy into a bounded writable workspace inside the container.
Operator Docker environment belongs to the launcher, not the guest. Preserve
the existing explicit Docker environment/context behavior. Audit inherited
allowlist variables (including SSH sockets and Node options) rather than assuming
that the existing general host-child allowlist is appropriate for every backend.
Provider/cloud credentials stay in the controller. Environment filtering alone
is not isolation from another same-user host process.

Container policy mirrors the existing snapshot backend: `--pull never`, `--init`,
read-only root filesystem, all capabilities dropped, no-new-privileges, 64 PIDs,
memory/swap and CPU limits, no network, nonroot host UID/GID, read-only snapshot,
bounded workspace tmpfs, and noexec/nosuid/nodev `/tmp`. Build output goes to
stderr, then the command replaces the worker shell. Quoted argv must retain
literal quotes/newlines/metacharacters. No failure switches execution to host.

Snapshot verification before and after is necessary but is not proof against
concurrent host modification during execution. Snapshot ownership/immutability
is a controller responsibility; qualification must preserve that invariant.

## Lifecycle

1. Validate request, host support and snapshot; reject already-cancelled work.
2. Resolve local image to immutable Docker identity, never pull implicitly.
3. Allocate a controller-owned container name. Create before attaching, so
   cancellation has a known cleanup target even if create's reply is lost.
4. Start and attach; close stdin after canonical input. Drain both streams
   concurrently within separate byte caps. Execution deadline covers control
   operations and attachment, not just the child's running time.
5. On cancel/deadline/output overflow, stop launcher process group and remove the
   named container. Reap descendants so inherited open pipes cannot hang return.
6. Cleanup has its own bounded deadline independent of the cancelled token.
   Confirm removal; if daemon state is unavailable report unconfirmed cleanup
   with enough retained identity for recovery. Recheck snapshot and return once.

The existing Docker implementation does not establish cleanup after an arbitrary
SIGKILL of the entire controller. Do not claim it does. Native crash cleanup needs
an explicitly designed independent watchdog or later recovery mechanism; RAII
and async cancellation alone do not solve SIGKILL. Keep crash recovery as a
visible capability gap until tested. smolvm has different watchdog semantics.

## Acceptance tests

Use OS subprocess fixtures for lifecycle faults and an opt-in real local image
for isolation tests. A fake Docker executable alone cannot qualify isolation.

- Happy path: snapshot input, optional build, deterministic stdin/output/exit,
  unchanged snapshot, local immutable image, no retained container.
- Nonzero guest exit is a result; launch/control failure is distinguishable.
- Missing image/runtime, unsupported host/root user, or invalid limits fail
  explicitly without image pull, backend substitution or host execution.
- Cancel before resolution, during create, after create/before start, and while
  attached; forced output overflow on each stream; deadline at each phase.
- A launcher or `sg` descendant retains pipe descriptors: deadline still returns,
  descendants stop, and named-container cleanup runs.
- Lost create response and failed/slow removal retain accurate cleanup status;
  clean cancellation and deadline do not cancel the cleanup attempt itself.
- Guest stdout resembling protocol events, container IDs, paths or PIDs cannot
  influence controller authority. Invalid UTF-8 and split codepoints survive
  bounded capture without panic; emitted stdout/stderr do not corrupt protocol.
- Command arguments containing quotes, spaces, newlines and shell metacharacters
  arrive literally; command and build order match existing behavior.
- Snapshot tampering and symlink/path-boundary violations are rejected under the
  existing snapshot contract. A read-only guest mount cannot mutate host source.
- Real guest cannot reach network or see provider credentials/host home; verify
  actual UID, rootfs policy, capabilities, writable temp paths and configured
  memory/PID limits. No assumption that Docker merely accepted flags suffices.
- Existing Docker context/TLS selection works; local stale-group recovery is
  scoped to already-granted membership and never overrides remote context.
- Graceful CLI signal produces cleanup; abrupt controller SIGKILL behavior is
  separately measured and reported, not folded into the graceful test.

Existing regression references: `improvement/sandbox-process.test.ts`,
`improvement/docker-group-recovery.test.ts`, `improvement/sandbox-security.test.ts`,
`improvement/smolvm.test.ts`, `verify/replay-runner.test.ts`,
`scripts/smoke-{smolvm,smolvm-toolbox,docker-replay}.mjs`.

Later interactive qualification additionally needs partial-frame handling,
bidirectional backpressure, initial-input ordering, callback/transport failure,
guest EOF/broken pipe, and cancellation during plugin RPC. Later smolvm needs
version/banner compatibility, archive replacement rejection, runtime-state
separation, integer CPU validation, mount validation, parent-death behavior,
confirmed VM disappearance and retained recovery state after cleanup timeout.
