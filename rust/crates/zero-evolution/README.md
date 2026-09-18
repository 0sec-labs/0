# Immutable generations and lifecycle

This is native registry infrastructure, not an autonomous improvement loop.
It does not execute candidates, run an evaluator, claim an oracle succeeded,
load/unload executable code, or undo external effects. The trusted controller
owns its database and these APIs; generated plugins must not receive access.

`Registry::open(path, initial_schema, initial_state)` opens a separate SQLite
registry. Initial state is used only on first creation. Application identity and
schema version reject unrelated/future databases. Transactions use a five-second
busy timeout and immediate writer locking. Artifact blobs are capped at 64 MiB;
manifest, receipt and state JSON records at 1 MiB; protocol/schema identifiers,
component counts and evidence counts are bounded.

## Identity and eligibility

- `put_artifact(bytes)` retains immutable bytes under their SHA-256.
- `register_generation(Manifest)` requires retained engine, component and policy
  artifacts and hashes canonical JSON. A generation describes the complete
  configuration, protocol and state compatibility; changing it changes identity.
- `record_evaluation(EvaluationReceipt)` retains a report bound to exact candidate,
  baseline, evaluator build, policy and evidence identities. Evidence must exist.
- `admit_eligibility(candidate, receipt, baseline, evaluator, policy)` checks every
  supplied identity and the report's Eligible decision. It does not activate code.
- `authorize_baseline(generation, reason)` explicitly trusts an **unmeasured**
  bootstrap. It is allowed only before initial activation. Unused bootstrap
  permissions cannot activate another generation after epoch zero.

Receipt bytes and hashes preserve attribution, not evaluator honesty. The caller
must establish evaluator authority and apply its actual qualification policy.
A caller-supplied Eligible value is not a cryptographic attestation. Recorded
rejected/inconclusive reports cannot pass `admit_eligibility`.

## Preparation and publication

`prepare_activation(target, eligibility, expected_state, callback)` passes the
current state and immutable manifest to a trusted preparation/migration callback.
The callback returns provisional state in the target's declared schema. No live
state changes until `commit(preparation_id)` atomically compares epoch, current
generation and state digest, advances the epoch and records activation history.
A forward activation requires evaluation against the currently active baseline.

The callback is synchronous and should prepare only provisional resources and a
copy of state. It runs outside SQLite's writer transaction. If it fails, exceeds
a bound, or loses a race, the caller must dispose provisional resources. This
crate cannot roll back arbitrary work performed inside the callback. It never
calls candidate code automatically. An async runtime resource owner can perform
its own preparation before supplying the final staged state; it remains
responsible for retaining readiness through commit.

Prepared tickets belong to the exact live Registry instance. Restart retains
intent but cannot commit old readiness; re-prepare resources. Commit is a
single-use CAS, not an idempotent replay of activation. Reopening never rewinds
state or resets the epoch.

`prepare_rollback` requires a previously active implementation compatible with
the **current** state schema, passes current state into preparation and creates a
new activation epoch. It does not restore historical state, rewrite evaluations,
refund usage, or label the rollback an empirical improvement. A previously
activated bootstrap baseline may be selected this way; arbitrary unused
bootstrap permissions remain unusable.

## Leases and resource ownership

`acquire_active(owner)` atomically pins the current generation and epoch in a
durable lease. `release(lease_id, owner)` checks ownership and is idempotent.
`lifecycle(generation)` reports Active, Draining with outstanding leases, or
Inactive. Replacing a generation does not invalidate already acquired leases.

Leases do not expire, auto-release on Drop, or disappear on restart. An external
supervisor must fence/quiesce a dead owner before explicitly releasing its
leases. `list_unreleased_leases(owner, generation, after_id, limit)` recovers
committed lease identities even if a crash lost the acquisition reply. Optional
owner and generation filters combine with AND; pages contain at most 256 rows,
ordered by ID with an exclusive last-returned-ID cursor. Release remains manual
and owner-checked. Listing does not establish owner death or permit disposal.

Pagination is not a snapshot across calls. New random lease IDs can sort before
a cursor; fence acquisition before recovering an owner's leases, or rescan from
the beginning once quiescent. Released leases disappear from subsequent pages.
This crate supplies neither distributed liveness detection nor fencing.
Lifecycle is a momentary generation-level view, not exclusive disposal authority:
rollback can reactivate a generation after an Inactive read. The resource owner
must serialize disposal with reactivation and key actual runtime handles by
activation epoch, including when the same generation returns after rollback.
Actual asynchronous cleanup belongs to that resource owner. Active means the selected registry identity, not proof that
resources are healthy or code was loaded. No cleanup-success receipt is invented.

## Validation and integration

Tests cover concurrent activation CAS, restart persistence, lease ownership,
failed migration preserving current state, stale readiness after restart,
current-state rollback, unchanged evaluation receipts, bootstrap restrictions,
evaluator mismatch, size bounds and foreign database rejection.

Engine integration must connect this registry to actual resource preparation,
health checks and disposal; session generation pins; evidence/evaluator policy;
and existing durable budget reservations. Campaign proposal loops, hidden
controls, canary execution and runtime migrations are not implemented here.
The existing TS `plugins/live-harness.ts` and `improvement/` remain behavior
references. This foundation separates eligibility from activation instead of
copying the old combined candidate/active status vocabulary.


## Scoped strategy registry (schema 2)

Writable opening migrates the exact legacy schema atomically and establishes a
stable UUID identity bound to retained genesis bytes. Existing generations,
receipts, leases and runtime state are preserved. Read-only access never migrates;
legacy inspection remains available, while strategy APIs require schema 2.
Missing or altered identity/schema fails closed rather than issuing a new identity.
Copies of a registry retain the same identity; this is not distributed fencing.

Strategy generations require typed bootstrap or measured-import eligibility.
The generic trusted receipt and bootstrap methods cannot authorize that kind.
The Harness must actually prepare the graph for the initial baseline. Measured
imports accept only the compiled host bridge's source-verified evidence path,
revalidate imported bytes, and commit artifacts, evaluation, scoped eligibility
and idempotency receipt in one transaction. A caller-authored report is not the
bridge's input authority. Private evidence remains retained for offline reassessment.

A measured scope binds whole baseline/candidate manifests, registry identity,
baseline epoch and state, evaluator/renderer/host policy and all imported artifact
hashes. Forward preparation and commit reject stale pins or corrupt evidence.
A canary-required policy remains blocked until genuine supported canary evidence
exists; import never fabricates it. Exact successful import retries return the
historical receipt plus current usability without reopening the source or rerunning
work. Candidate generation and canary adapters must preserve campaign quotas and
are not supplied by this registry library.

A protected suite can issue only one measured grant in a registry, including when
the mutable import projection is missing: its immutable scoped eligibility still
records consumption. Exact command retries remain available. Pre-exposure fencing
is local to the evaluation Store; cross-Store exposure before import still requires
trusted host corpus governance. Registry import uniqueness is not a claim of global
holdout secrecy or distributed locking.
