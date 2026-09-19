# Persistent sandboxed plugin workers

`zero-plugin-runner::Runner::start_worker_in` starts a language-neutral persistent
worker using the existing offline Docker sandbox. The host supplies a launch
profile, a caller-recorded absent staging path, a first `Harness::begin_call`
permit, limits, and an explicit capability handler map. Interpreter arguments
are literal argv entries. Python, Node, or another interpreter must already exist
in the selected local image; this path never pulls images or executes the plugin
on the host. Persistent Smolvm transport is explicitly unsupported.

One worker retains one exact plugin manifest and generation/epoch for its entire
lifetime. `RunningWorker::submit` requires a separately issued `PinnedCall`, checks
its issuer and pins, and accepts at most one waiting call. Calls execute serially.
Existing issued calls can finish against their captured generation after a switch;
fresh calls use the active Harness generation and cannot enter an older worker.
No operation repins a running interpreter or releases a lease on a timer.

The worker sends newline-delimited UTF-8 JSON on stdout; stderr is diagnostic
output. Every frame has a strict `type` discriminator. It first sends
`{"type":"ready","version":1}`. The host then sends:

```json
{"type":"invoke","id":1,"call":{"tool":"inspect","input":{}}}
```

The worker returns `result` with `id` and `result`, or `error` with `id` and an
`error` object containing numeric `code` and bounded `message`. During the call
it can request a host operation:

```json
{"type":"capability_request","call_id":1,"id":1,"operation":"host.inspect","input":{}}
```

Callback IDs must increase across the entire worker lifetime. The host replies
with `capability_result` (`call_id`, `id`, `result`) or `capability_error`
(`call_id`, `id`, `error`). Unknown operations, absent captured grants, and invalid
host schemas receive denial without invoking a handler. The worker does not
supply an authority flag, target policy, approved spend, or capability mapping.
The host ends a drained session with `{"type":"shutdown"}` and closes stdin.
A worker must exit under its original launch deadline; shutdown grants no new
execution allowance.

`CapabilityHandler` binds an operation to a required capability, a validated
input schema, and trusted `HostCapability` code. The broker checks each call's
captured invocation grants before constructing `AuthorizedCapability`. Handler
code must enforce actual target and spend policy, honor cancellation before
physical effects, durably record effects where required, and join its children.
A plugin's `network` or `model-call` declaration by itself never grants a URL,
credential, model budget, direct guest network, or host process execution. No
built-in paid, HTTP, or arbitrary host-shell adapter is enabled by this module.
The Docker worker still has the existing network-disabled, resource-limited,
nonroot disposable snapshot environment and immutable resolved image identity.

The frame ceiling is 1 MiB excluding newline, result ceiling 100,000 encoded
bytes, stdin queue four bounded writes, output queue sixteen 8 KiB chunks, and
pending decoded queue sixteen frames. Worker limits cap calls at 64 and callbacks
at 1,024, with an independently bounded aggregate stdout/stderr capture inherited
from the launch profile. These are finite per-worker limits, not renewed per
invocation. JSON-safe positive IDs, strict envelopes, exact correlation,
monotonic callback IDs, and complete final-stream reassessment reject replay,
truncation and trailing unsolicited frames. Overflow cancels the worker.

`WorkerReply` is provisional untrusted data. Await `RunningWorker::finish` before
using `WorkerOutcome::backend_settled()` as a prerequisite for explicitly calling
`Harness::complete_settled` for each returned permit. Completion establishes only
transport settlement, never a finding, successful reproduction, eligibility,
security conclusion, or truth of a plugin's result. A failed or cancelled worker
can have settled effects; conversely, a returned result does not establish safe
teardown.

Dropping a worker or its join future requests cancellation without aborting the
sandbox supervisor. Cooperative broker cancellation is joined, followed by the
existing Docker process-group and container cleanup. Unknown daemon removal,
broker panic, an explicit unsettled host effect, or an unjoined callback produces
`WorkerStatus::Unknown`, preserves staging, and leaves every durable lease held.
An unjoined callback is returned as `PendingCapability` for host reconciliation;
dropping that handle does not abort uncertain effects or release a lease. A lost
owner/runtime similarly requires explicit fenced recovery, never automatic
replay. Cancelled and timed-out states retain their original deadline semantics.

The deterministic fake-Docker tests qualify duplex lifecycle, authority checks,
correlation, backpressure and lease handling; they are not isolation tests. The
opt-in `actual_offline_python_worker_persists_across_calls` fixture requires an
already installed local Python image and is ignored by default. The existing
one-shot runner and wire remain available unchanged. This library API is a
production transport boundary. Engine routing is a separate explicit host opt-in,
described below; standalone `RunPlugin` remains one-shot.


## Actor-owned Engine routing

After `Engine::configure_plugins`, an idle host can call
`Engine::configure_plugin_workers(BTreeMap<String, PluginWorkerPolicy>)`. Each
policy names one already prepared plugin, schema version 1, a lifetime limit of
1–32 calls and 1–128 callbacks, and an explicit subset of `list_source_files`,
`read_source_lines`, `search_source_text`, and `http_request`. At most four plugins
can be opted in. The Docker launch must use an immutable image digest. This is
host configuration; model input cannot enable or expand it.

The actor captures these policies with its existing plugin tools. Only selected
aliases route through an actor-local pool; processes are never shared across
actor roots, continuations or restarts. Every invocation gets its own issued
lease, while the worker keeps its original plugin, generation, epoch and absolute
deadline. The Store checks the original completed inference, tool position,
arguments, offered alias and captured capabilities before binding the call.

Preparation captures the graph, stages it on an awaited blocking task without
holding Engine locks, and retains the exact sandbox request artifact and digest.
A one-use durable physical-start gate checks owner, actor and deadline before the
guest starts. Source callbacks use the actor's existing pinned source context;
HTTP callbacks use its existing private client, target policy and original HTTP
account, including redirect-hop authorization and reservations. Delegated roles
cannot restore native tools removed from their captured tool list. This adapter
accepts no guest-selected headers; credentials and default headers remain with
the private client. There is no callback for paid model calls, arbitrary host
execution, finding verification or permission changes.

Approving a plugin alias authorizes only that exact invocation. When the actor
requires `http_request` approval, a worker callback independently waits for a
version-2 approval over the normalized HTTP intent. Denial performs no target
request. Approval consumption, callbacks and actual HTTP hops have distinct,
linked receipts; no synthetic model tool call is inserted. Retained HTTP readers
rederive the callback chain back to the original successful model inference.

Provisional replies are retained artifacts and explicitly labeled provisional in
model context. Their plugin operations stay Running until the worker and all
callbacks have drained. The actor joins worker supervisors before releasing its
source copy or settling its own result. Known clean shutdown releases each lease
explicitly. Uncertain backend cleanup, callback settlement or owner loss leaves
operations Unknown and leases outstanding, including original HTTP holds. The
Engine never restarts that worker or replays a callback on an exact actor retry.
Preparation/journal failures after acquiring a lease also require reconciliation
when the controller cannot establish a complete terminal receipt.

`read_plugin_worker_call` reads retained invocation outcomes without configuring
plugins or starting execution. It checks the Store binding, original inference,
prepared request, physical-start receipt, immutable image, worker cleanup and
exact provisional reply artifact. An unfinished or opaque recovered outcome
remains absent. Neither a plugin result nor successful transport is an
independent security or reproduction conclusion.

Engine tests exercise a real local provider fixture, pinned source access and
loopback HTTP through the actual actor/Store path. The fake Docker launcher only
qualifies transport and host authority: physical Docker isolation qualification
remains the separately ignored opt-in test above.


## Local real-Docker qualification

The opt-in Python worker test accepts `ZERO_TEST_PYTHON_IMAGE` to select an
already installed image. The executor always uses `--pull never` and overrides
an image's configured entrypoint with the controlled shell/bootstrap. A pinned
image with its own application entrypoint therefore cannot intercept the host's
retained worker argv.

On 2026-09-19 the two-call Python persistence test and the executor's real
isolation/build/cancellation test passed locally using installed image
`sha256:0461844e338a379bd3379976a753e5467dce5361a471fbecff593fa477e3d7f6`.
The latter checks nonroot execution, readonly snapshot/root filesystem,
loopback-only networking, empty effective capabilities, no-new-privileges,
memory/PID limits, literal arguments, no inherited host credentials, and joined
cancellation cleanup. No image was pulled and no external target/provider was
used. This qualifies that local image/environment and these assertions; it is
not certification of arbitrary images, all platforms, or all Engine callbacks.

```sh
ZERO_TEST_PYTHON_IMAGE=sha256:YOUR_INSTALLED_IMAGE \
  cargo +1.85 test --locked -p zero-plugin-runner --test worker \
  actual_offline_python_worker_persists_across_calls -- --ignored --exact
ZERO_DOCKER_SMOKE_IMAGE=sha256:YOUR_INSTALLED_NODE_IMAGE \
  cargo +1.85 test --locked -p zero-executor --test docker_smoke -- --ignored
```
