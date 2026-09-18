# smolvm and Docker in the native rewrite

Status: researched design with initial native implementation, 2026-09-18.
`zero-smolvm` now implements the batch primitive with its own request/result types;
it is not connected to the application execution protocol. Docker is the first
implemented application execution path;
smolvm is a required distinct backend, not a synonym for Docker or an automatic
fallback. Existing TypeScript behavior remains the migration reference.

## Decision

Use smolvm for explicitly selected local microVM workloads where the qualified
runtime and hardware virtualization are available. Its separate guest kernel is
a useful additional isolation boundary for generated code and hostile tools.
Keep Docker for existing container deployments, hosts with an appropriate Docker
runtime but no usable virtualization, and the current native qualification path.
Both can consume the same prepared toolbox content, with different execution
identities and resource semantics. Neither is universally preferable.

A Rust controller does not need Docker to execute a smolvm worker. Building or
exporting its image using Docker is a provisioning choice. Do not confuse image
format, image preparation, outer cloud deployment and inner worker isolation.

| Situation | Choice and conditions |
| --- | --- |
| Local Linux with usable KVM and qualified smolvm | Offer explicit smolvm execution, using a pinned local archive and private state. Prefer it when a separate guest kernel is required. |
| Local Docker installation without usable KVM | Docker remains a supported explicit choice. A requested smolvm run fails with its missing prerequisite, not a fallback. |
| macOS or Windows | Upstream supports hypervisor backends; 0sec's existing smolvm adapter does not qualify them. Native support requires separate platform lifecycle tests. |
| Managed worker already confined by the cloud | Preserve the deployment's execution policy. Run within that worker only when its contract authorizes it; do not assume another nested sandbox is available or required. |
| Managed worker selecting nested Docker | Requires an explicitly provisioned daemon/runtime and policy. Never mount the host Docker socket as an incidental workaround. |
| Dedicated cloud VM/node selecting smolvm | Requires usable KVM or supported nested virtualization, runtime artifacts, storage and lifecycle ownership. Qualify on the actual worker image and kernel. |
| Ordinary container/pod without virtualization access | Cannot promise smolvm. Exposing `/dev/kvm` alone does not establish the complete operational or isolation contract. |
| Kubernetes smolvm RuntimeClass | Upstream offers a containerd shim; this is a separate deployment integration, not parity with our CLI adapter. |

Docker containers share the kernel of their container host; Docker Desktop may
itself place that host inside a VM. smolvm workloads have a guest kernel through
libkrun/libkrunfw and the platform hypervisor. This distinction supports an
isolation decision, not an unmeasured claim that one is faster or immune to
escapes. Forwarded mounts, networking and credentials remain authority in either
case.

## Installed environment: observed, not assumed

Read-only checks in this development environment found:

- `/home/dev/.local/bin/smolvm` reports `smolvm 1.14.6` and resolves to the complete
  launcher bundle at `/home/dev/.local/share/smolvm-1.14.6-linux-x86_64/smolvm`.
- `setpriv` is installed at `/usr/bin/setpriv`.
- `/dev/kvm` exists with ownership `root:kvm`, mode `0660`.
- The current agent process has UID 1000 and only its `dev` group; opening KVM
  directly returns `EACCES`.
- The account database already lists `dev` in `kvm`. A child launched with
  `sg kvm` successfully opens KVM and `KVM_GET_API_VERSION` returns 12.

The current process has stale supplementary groups. Restarting the login/process
with its already granted groups resolves that prerequisite; changing device
permissions is unnecessary. The existing TypeScript smolvm adapter does not
implement Docker's group-refresh helper. Any native refresh facility must be
explicitly scoped to existing membership and preserve lifecycle guarantees.

The initial read-only review did not boot a VM. The subsequent authorized native
implementation smoke booted the existing Node archive through `sg kvm`: exit 0,
UID/GID 1000, expected stdin, absent provider credential/Docker socket, confirmed
cleanup. Archive SHA-256: `2bda0b195b4a451d7e3c516a2c08178024f4407e60e7abfed831eb5f06444c48`.
No runtime upgrade, image pull or host permission change occurred. This one batch
smoke is narrower than full backend qualification.

## Source versions

Official upstream HEAD inspected:
[`adec01f0df99aaf820aa09d4e6e665a31ac3ec07`](https://github.com/smol-machines/smolvm/tree/adec01f0df99aaf820aa09d4e6e665a31ac3ec07),
whose Cargo package version is 1.16.1. Installed/0sec-qualified release source:
[`v1.14.6`, `6c503014629bba91631152728c3081c944653f31`](https://github.com/smol-machines/smolvm/tree/6c503014629bba91631152728c3081c944653f31).
Do not silently replace 1.14.6 with current upstream and inherit qualification.

Relevant upstream sources:

- [Release README](https://github.com/smol-machines/smolvm/blob/6c503014629bba91631152728c3081c944653f31/README.md): OCI/local archives, supported hypervisors, trust model and deployment options.
- [Release machine runner](https://github.com/smol-machines/smolvm/blob/6c503014629bba91631152728c3081c944653f31/src/cli/machine.rs): foreground ephemeral banner, unprivileged guest flag and `watch_parent: Some(!self.detach)`.
- [Current boot watchdog](https://github.com/smol-machines/smolvm/blob/adec01f0df99aaf820aa09d4e6e665a31ac3ec07/src/internal_boot.rs): parent-change monitoring and its platform/lifecycle conditions. Foreground machine execution supplies its own parent-watch selection; detached machines intentionally differ.

Upstream feature and performance statements were inspected, not benchmarked.
The current upstream platform matrix is broader than our qualified backend.

## Existing 0sec implementation to preserve

`packages/core/src/runtime/smolvm.ts` implements a narrow profile:

1. Non-root Linux, exact `smolvm 1.14.6`, `setpriv`, integer vCPU count, bounded
   memory/storage/deadline/output and a prepared local archive.
2. Open archive without following its final symlink; require a nonempty regular
   file at most 8 GiB. Copy and SHA-256 hash the actual bytes into a private run
   directory before boot. Compare against the recorded expected digest.
3. Give each run isolated HOME/XDG/temp/cwd paths and an allowlisted environment.
   Exclude project Smolfiles, ordinary user runtime state, credentials, proxies
   and ambient feature overrides. Only deliberate runtime-location overrides
   survive.
4. Execute `setpriv --pdeathsig KILL -- smolvm machine run --image <private-archive>
   --unprivileged --user 1000:1000 ... --interactive -- <argv>` without `--net`.
   Read-only mounts are explicitly validated; no host-execution fallback exists.
5. Verify the exact ephemeral-launch banner before accepting the runtime
   protocol, preserve literal argv/stdin, cap both output streams and terminate
   on cancellation/deadline/overflow or channel failure.
6. Tie controller death to launcher death and foreground launcher death to VM
   death. Confirm absence of owned runtime processes before deleting private
   state; retain recovery state if cleanup cannot be confirmed.

`resolveSmolvmImage` identifies **archive bytes**, not an OCI manifest digest or
Docker daemon image ID. Docker and smolvm identities must not be compared as if
they name the same representation.

The TypeScript documentation describes toolbox checks for 37 commands, selected
Python imports, guest-loopback TCP tools and a Foxguard positive/negative fixture.
That is useful qualification scope; it does not establish live-target networking,
browser/privileged tool support or general scanner accuracy. It also explicitly
does not globally redirect console/PTY, replay or exploit commands into microVMs.

The smolvm guest has disposable writable storage and its own kernel. The adapter
does not claim Docker-equivalent PID limits or `noexec` tmpfs. Full archive copy,
hash and import can dominate startup for a large toolbox; no startup or memory
advantage is claimed without measurements on the actual images.

## Proposed native execution contract

Coordinate with the existing native executor rather than adding another engine.
The current `zero-protocol` execution request and `zero-exec` result are
Docker-specific. Before adding smolvm, introduce an explicitly versioned backend
selection and preserve its identity through admission, execution and recovery.
No protocol change is made by this document.

- `Backend`: Docker or smolvm, with separately validated backend configuration.
- `ArtifactIdentity`: Docker local image ID versus archive SHA-256 plus the
  immutable provisioned archive location. Keep snapshot source identity separate.
- `Resources`: common deadline/memory/output intent plus backend-specific CPU and
  storage options. Docker accepts fractional CPUs; smolvm's qualified adapter
  requires integer vCPUs. Unsupported requested limits fail explicitly.
- `Capabilities`: advertise qualified host, networking, mount, interactive I/O
  and cleanup behavior. A generic flag must not imply equivalent enforcement.
- `ExecutionHandle`: controller-owned execution ID, backend, runtime version,
  pinned artifact, private recovery directory and verified lifecycle identity.
  Never derive authority from guest output or accept a guest-provided PID.
- `Cleanup`: retain NotCreated/Confirmed/Unconfirmed semantics but replace the
  Docker-only unconfirmed container field with a tagged backend-specific recovery
  reference. CLI exit is not proof of VM termination.
- `Result/events`: keep the native executor's bounded raw stdout/stderr bytes and
  typed events. Human launch banners stay inside the adapter, never the durable
  application protocol. Qualification must cover split/invalid UTF-8 separately
  from raw byte capture.

Use the same owned lifecycle task, cancellation/drop behavior and durable
operation accounting as Docker. A panic or lost response yields an uncertain
operation requiring reconciliation, never automatic re-execution. Unknown
external completion and unconfirmed cleanup are separate facts.

Initially supervise the qualified CLI bundle. Linking libkrun or adopting
upstream Rust SDKs is a different implementation with a different process,
watchdog and cleanup contract; matching implementation language is insufficient
reason to change both at once.

## Qualification gates and gaps

Port tests from `packages/core/src/improvement/smolvm.test.ts` and
`scripts/smoke-smolvm.mjs`; run the actual native path, not a mock or the TS
adapter. Required cases include:

- No KVM access, absent/wrong runtime, root host and unsupported platform fail
  before execution; none causes a Docker/host fallback or image pull.
- Immutable archive identity, replacement races, invalid archives and read-only
  snapshot behavior; reject host configuration/secret leakage.
- Real guest UID, CPU/memory/storage behavior, offline networking and literal
  argv/stdin with separated streams.
- Cancellation before boot, during import, while running and after output; both
  stream floods, deadline and controller drop. Test abrupt SIGKILL separately
  from cooperative cancellation and observe actual VM disappearance.
- Detached helpers, launch protocol changes, failed cleanup and restart
  reconciliation retain accurate recovery state and never signal unrelated
  processes. Audit `/proc`-based ownership and PID reuse rather than copying
  heuristics without review.
- Interactive plugin framing, backpressure, broken pipe/EOF and callback failure
  need separate qualification after batch execution works.
- Actual installed release artifact, not just `cargo test`, must find the full
  runtime bundle and pass its prerequisite/launch/teardown checks.

The current shell can regain already granted KVM access. Seven fake-launcher
tests and the small-image native smoke passed; the full real gates above remain
outstanding. Reuse the existing toolbox archive only after confirming its
exact bytes and provisioning; do not install tools or download images implicitly.

Related documents: [native architecture](2026-09-18-native-harness-architecture.md),
[execution migration](../../rust/EXECUTION-DESIGN.md), and the existing
[smolvm operational instructions](../src/content/docs/improvement-plane.md).
