# Faster chat and isolated tools

Status: architecture decision and qualification plan, October 2, 2026. The prepared-image and warm-pool paths described below are **not implemented or qualified** in this engine.

## What is slow today

The isolated console waits for its guest controller before making the first model request. Even a greeting starts the workspace VM. `WorkbenchController.start()` launches `runSmolvmWorkbench()` and waits for the guest's `ready` frame; `sendMessage()` waits for that startup before sending the turn.

Each new chat creates private HOME and XDG cache/data directories. It verifies the approved image archive, captures a bounded source snapshot, clones and verifies the archive again, and invokes `smolvm machine run --image <private.tar>`. The private cache prevents cross-chat mutable state from leaking, but also prevents ordinary reuse of imported image state. The large toolbox is imported into a new ephemeral guest rather than starting from an already prepared toolbox disk. A running chat retains its VM until its idle/lifetime deadline, so later turns do not repeat this entire path.

The inspected chat's creation timestamp to running-state update was approximately 137 seconds. This interval includes controller preparation and startup; it is not an isolated measurement of hypervisor boot. A read-only SHA256 pass over the selected approximately 2.2 GiB archive took 1,568 ms and matched its approved digest. A separate capture of this repository using the existing compiled snapshotter copied 9,036 files / 131,893,446 bytes in 5,328 ms; its private destination was removed afterward. These measurements do not run concurrently with the original turn or isolate the same disk conditions. Hashing and source capture alone therefore do not explain the observed delay. We have not measured a complete phase breakdown or a cold-versus-warm comparison. An active workbench lease prevented an additional competing VM qualification run.

## Product behavior

Chat should be able to answer a greeting, ask a scope question, and explain its plan without starting a Linux environment. Start the isolated tools environment only when a tool actually needs code or Linux execution. If a workspace has already been selected, preparation can overlap the model request under the same resource admission rules.

Keep a small runtime indicator in the chat context panel: **Local**, **SmolVM · preparing**, **SmolVM · ready**, or **SmolVM · stopped**. Show an environment selector in settings or new-chat setup. Selecting local execution must be an explicit choice; a failed sandbox must never silently run tools on the host. Docker can be a separate supported executor if implemented and qualified, rather than an alias for SmolVM. The indicator describes tool execution; model inference location is a separate connection detail.

Do not use model-generated filler text to conceal startup. Show the actual phase while preparing, report a busy admission immediately, and let cancellation release only this chat's owned resources.

## Recommended execution architecture

Use three boundaries:

1. The web/CLI controller owns conversation state, workflow scheduling, provider selection, permissions, and durable evidence. It can run the conversational model loop without granting host shell or filesystem tools.
2. A tool executor acquires a private Linux sandbox when needed. It receives the selected source snapshot, bounded task input, and task-specific policy. It returns structured tool output and artifacts. Credentials stay behind the provider/service broker.
3. A sandbox manager owns approved base images, preparation, admission, health checks, and cleanup. It exposes executor operations rather than raw host mount selection to the model.

The host model loop and guest tool dispatcher need a new protocol boundary; today the model loop itself runs inside the guest. Splitting them requires preserving tool catalogs, operator decisions, cancellation, token accounting, learning hints, and resumable history. It is not a frontend-only change.

Keep the approved security toolbox in the Linux base image. Kali tools do not require reinstalling Kali on every message or chat. Build and inventory the image once, then reuse its read-only base with a private writable layer for every workspace. Keep browsers and expensive services task-specific rather than starting them for every greeting.

## Local fast path

First qualify a prepared, clean toolbox disk or root filesystem that avoids importing the same TAR on every chat. Preparation belongs to explicit image setup, keyed by image digest, runtime version, architecture, and launcher policy version. Publish it atomically after digest verification and tool inventory. Never include workspace source, operator HOME, credentials, connections, provider requests, or conversation state in the reusable base.

Every launch still requires fresh writable disks/state, source snapshot, runtime identity, broker authorization, and cleanup ownership. Verification must detect modified artifacts; a file timestamp cache is not a substitute for archive identity checks. Do not share a writable extracted filesystem between unrelated guests.

If prepared disks still miss the latency target, qualify a small clean warm pool using a branchable parent parked before any task input. Each slot is assigned to one chat, receives a new broker identity and workspace grant, then is destroyed after use. Replenish slots from the clean parent rather than recycling a guest that has handled source or secrets. Admission needs to account for parent and held-child resources; the present single-workbench admission/teardown model cannot simply be bypassed.

The pinned private runtime is **SmolVM 1.14.6**, not a shell-installed executable. Its local `machine --help` confirms `branch`, `branch-release`, `checkpoint`, and `pack create`; `machine branch --help` confirms held pool slots. The official [SmolVM README](https://github.com/smol-machines/smolvm/blob/main/README.md) describes copy-on-write branches and portable artifacts. These are available building blocks, not evidence that this engine already uses them or achieves upstream advertised timings.

### Why not switch to `--from` immediately?

The pinned [machine command implementation](https://github.com/smol-machines/smolvm/blob/v1.14.6/src/cli/machine.rs) routes `machine run --from` through `PackRunCmd`. That handoff does not forward the current `--unprivileged` policy. The [packed runner](https://github.com/smol-machines/smolvm/blob/v1.14.6/src/cli/pack_run.rs) also permits baked manifest networking when there is no explicit network override. A manifest prepared with network enabled could therefore defeat the engine's network-disabled launch intent. The packed runner comments additionally describe guest-side layer assembly on first boot, so packing an OCI archive alone does not prove that extraction costs disappear.

A safe integration must inspect the packed manifest, reject unexpected topology or inherited grants, preserve explicit disabled networking and unprivileged execution, and adapt the native supervisor's launch/readiness/teardown proof. Resolve these issues in a qualified runtime or launcher before enabling the path. Do not trade current isolation guarantees for a shorter spinner.

## Tenant deployment

Use the same controller/executor boundary inside a customer's tenant. The dashboard, conversation data, source, workers, artifacts, and inference connections can all remain in their VPC. A tenant worker service maintains a bounded pool of clean Linux sandboxes and handles task admission. Pool keys include tenant, approved image, architecture, and policy; workspace-bearing guests are never shared across tenants.

SmolVM on Linux requires appropriate virtualization support. Firecracker/Kata or a container executor are alternative deployment adapters to evaluate against the tenant's cluster constraints. They do not remove image preparation, isolation, or source-staging costs by themselves. Start with the current runtime and measure prepared bases before changing virtualization technology.

## Acceptance checks

Targets below are engineering goals, not measured promises:

| Measure | Initial target | Required observation |
| --- | --- | --- |
| Text-only chat | No sandbox wait | No executor launch or guest resource admission |
| Prepared small-workspace tool startup | p95 below 5 seconds | Tool request to authenticated guest-ready, excluding model latency |
| Warm-slot assignment | p95 below 1 second | Admission to worker-ready with fresh task identity |
| Cold toolbox preparation | Measured separately | Import, hashing, disk creation and inventory timings |

Record at least 20 repeated launches on the same host with the same image/resources and representative source sizes. Report p50/p95, cold preparation separately, workspace copy separately, failures, disk growth, and idle memory. Repeat with the selected full toolbox; a tiny fixture cannot establish its performance.

Before enabling a fast path, verify disabled egress, absence of inherited source/secrets, private guest writes, unchanged host source, cross-slot isolation, fresh broker credentials, image tamper rejection, cancellation during preparation and execution, parent death, stale lease recovery, and confirmed cleanup. Rerun the existing authenticated-provider and source-learning round trips through the new executor boundary.

The current selected toolbox still needs its missing SSH tooling qualified. There are approximately 17 GiB free on this host; image preparation should be performed on a suitable build host rather than consuming the remaining disk or stopping an unrelated live VM.
