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
production transport boundary; it does not automatically route the Engine's
existing one-shot plugin commands into persistent workers or configure host
capability adapters.
