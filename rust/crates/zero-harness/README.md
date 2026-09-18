# Native generation-bound plugin graph

This crate connects `zero-plugin` admission with `zero-evolution` generation
selection and durable leases. It prepares **inert data and retained bytes**,
not running workers. There is no model execution, process hot-swap, dynamic
library loading, sandbox launch, health assertion, or cleanup-success claim.

## Complete identity and host authority

A supported evolution generation uses protocol 1 and configuration exactly
`{"native_plugin_graph":1}`. Each component key is `plugin:<plugin-id>` and
points to a canonical `serde_json::to_vec(&zero_plugin::Manifest)` artifact.
The manifest's own digest must match that component artifact (allowing only
evolution's `sha256:` prefix). All declared plugin artifact bytes are loaded
from evolution's verified content store and checked by plugin admission. Missing,
wrong-version or cyclic dependencies fail; every dependency resolves inside the
complete graph, and invocation data retains its transitive manifest pins.
The additive graph-2 strategy format described below is also supported. Native source components and unknown configuration formats reject.

`Harness::new(registry, expected_engine_artifact)` compares the caller-supplied
engine identity with every selected generation. The host must establish that
this is its actual engine build; the crate cannot attest the running binary.

`HostGrants::new` accepts trusted host policy, not serialized plugin authority.
Its `artifact_bytes()` must exactly equal the generation's policy artifact,
including the complete plugin set, capability grants, enabled flags and trust
metadata. Parsing an artifact never generates grants. Policies cannot drift
under the same generation digest. These are coarse plugin admission requirements,
not filesystem/network/engagement scope permission or evidence of OS isolation.
A broker must still enforce those controls and cancellation/trust revocation.

## Preparation and publication

`prepare_activation` verifies graph identities and grants, then delegates the
trusted migration callback to evolution's preparation mechanism. `commit`
consumes an instance-bound prepared switch and publishes via evolution's atomic
compare-and-swap. Failed preparation or a stale commit preserves the selected
state. `prepare_rollback` uses current state and previously active compatible
code; it never restores old state or relabels an evaluation. Eligibility and
caller-supplied evaluator authority retain evolution's documented limitations.

`restore_current` reconstructs the selected graph after restart, requiring freshly
supplied host grants. A selected SQLite generation is not readiness in another
process. At most eight generation graphs are retained in one Harness; exceeding
that requires restart/re-preparation and never evicts a pinned call. Each graph
is bounded to 64 MiB of referenced plugin artifacts. Graph retention concerns
in-memory bytes only; it does not establish external worker lifetime.

## Session and broker pins

The engine integration must persist `GenerationPin { generation, epoch }` for
sessions/work. The current engine's plain generation string alone cannot reject
an old epoch when rollback selects the same digest again. This crate does not
change existing engine/session schemas; it exposes the required structured pin.

`begin_call(expected_pin, owner, plugin, tool, input)` validates the immutable
graph and tool input and acquires a durable active-generation lease. It compares
both generation and epoch before returning an instance-bound `PinnedCall`. A
race with activation releases the unused lease and rejects the call. There is
no silent repinning. The graph is retained by Arc throughout the call; an old
issued call remains pinned after another generation is selected.

`validate_reply(call, BrokerPin)` checks generation, epoch, lease and plugin
manifest identity against a live issued handle. A pin received from a plugin is
only correlation data; it is never sufficient to create a handle or authority.
A broker must validate before accepting results or dispatching more work.
Copied invocation data and graph bytes are not execution permits.

`complete_settled` requires the trusted caller to establish that all backend and
broker work has settled. It explicitly releases the lease and rejects subsequent
replies. Drop does not release durable leases. After restart `unreleased` exposes
paged recovery identities; `release_fenced` requires the external supervisor to
fence/quiesce the owner first. No liveness detection, automatic expiry, adopted
handles, old-call resumption, or automatic reexecution exists. External users of
the evolution database must honor the same fencing contract before release.

## Relationship to Cordis

`packages/core/src/plugins/live-harness.ts` prepares candidates before selecting
an active graph, retains in-flight generation references and rejects stale driver
and closed broker authority. This native foundation preserves those boundaries
using immutable registry identities and durable leases. It does not port Cordis
resource injection, ESM execution, lifecycle hooks or asynchronous disposal.
Keeping a Rust Arc alive does not undo network effects or prove a guest stopped.

Validation: nine offline tests cover failed preparation, immutable grant/engine
bindings, complete dependency pins, canonical manifest identity, competing
activation CAS, old-call retention, stale replies, current-state rollback,
instance-bound handles and explicit lease discovery/release after restart.


## Advisory strategy generations

The exact graph-2 configuration from `strategy_configuration()` retains every
`plugin:*` component and adds one canonical `strategy:advisory` artifact.
`HostGrants::with_strategy` binds the fixed host template, provider/HTTP policy,
evaluator criteria, accepted suites and canary prerequisite. Its absence preserves
graph-1 policy bytes. `PreparedStrategy` is inert, validates advisory bytes and
uses the shared `strategy_advisory_v1` renderer; it cannot grant new tools or scope.

`bootstrap_strategy` works only on a fresh epoch-zero registry, prepares the
complete graph and atomically selects a trusted **unmeasured** baseline with an
idempotent installation receipt. `register_strategy_candidate` verifies the active
retained baseline and changes only its advisory component. Registration does not
select the candidate or grant eligibility. Existing plugin-only registries cannot
use bootstrap to replace their active generation.

`strategy_capture` requires an explicitly restored/prepared current graph and
returns the registry, generation, epoch, advisory and exact host authority for the
Engine's explicit strategy-session adapter. `inspect_strategy_capture` verifies
the retained graph without preparing runtime permissions. Existing captured
actors remain bound to their original advice; fresh stale-session admissions are
rejected by the Engine. Candidate imports do not mean activation or canary completion.
