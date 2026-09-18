# Native measured evaluation bridge

Proposal, 2026-09-18. This document does not implement evaluation or qualify a
candidate. Scope: bounded offline plugin generations executed by the native
sandbox runner, scored against a host-owned exact JSON contract. No live targets,
provider requests, source rewriting, deployment, or benchmark-quality claim.

## Existing contracts and the missing boundary

Sources inspected:

- `packages/core/src/improvement/{evaluation,config,types,loop,rewrite}.ts`
- `packages/core/src/bench/improvement-promotion.ts`
- `rust/crates/zero-evolution/src/{lib,lifecycle,types}.rs`
- `rust/crates/zero-harness/src/{lib,graph}.rs` and its README
- `rust/crates/zero-plugin-runner/src/{lib,stage}.rs`

No applicable ancestor/root AGENTS.md was found for these paths. The existing
`packages/core/src/agent/AGENTS.md` governs a different subtree.

The TypeScript evaluator pins baseline/candidate snapshots and configuration,
alternates variant order, compares canonical JSON outside the sandbox, retains
attempts, and scores development, held-out, and negative-control lanes. It checks
repeat stability and retention of every baseline success, uses unique cases for
Wilson intervals (repeats are not independent observations), and enforces bounded
execution costs. Config rejects duplicate canonical inputs across lanes. The
proposal loop exposes development feedback only. Its later canary trials call
the same configured evaluator/corpus again: fresh execution is useful stability
evidence, not an independently sampled held-out corpus. Its evaluator digest
includes selected function source strings; a native binary/dependency identity
should replace that incomplete implementation identity.

Native `Registry::record_evaluation` verifies retained artifact identities, not
that execution happened. `admit_eligibility` trusts the host and checks the exact
candidate/baseline/evaluator/policy plus Eligible decision. `authorize_baseline`
is explicitly an unmeasured bootstrap confined to an empty registry. A receipt
hash is neither a signature nor evidence that its author is authorized.

`Harness` accepts only native plugin graphs, verifies the exact engine/policy
artifacts and full dependency closure, and issues non-deserializable `PinnedCall`
handles for its active generation/epoch. `Runner::start` consumes one such call,
executes only offline capabilities, accepts exactly one matching RPC result/error,
and retains lease/staging on uncertain cleanup. It calls `SandboxExecutor`
directly: it does not create engine operations or reserve engine budgets. Graph
preparation is inert; a graph or copied BrokerPin is not permission to execute.

## Use isolated evaluator instances, never production bootstrap

For the first bridge, preserve existing production harness authority unchanged.
Create one private evaluator instance for each `(evaluation run, variant)`:

1. Freeze the two complete generation manifests and transitive retained artifact
   bytes. Baseline and candidate must differ. Require the supported engine build,
   protocol, native plugin graph configuration, and explicit host grants. Reject
   unsupported source components; do not label their bytes executable evidence.
2. Create separate mode-0700 controller-owned directories and fresh registries.
   Copy only the verified artifact closure and one generation into each. Never
   copy production eligibility, leases, runtime state, DB paths, or credentials.
   Store synthetic evaluation state with an explicit schema, not customer state.
3. In each empty private registry, authorize that generation as an **unmeasured
   evaluation-only bootstrap**, prepare/commit its graph and issue ordinary
   PinnedCalls. This is how the existing runner can exercise an unmeasured
   candidate without new production eligibility or a forgeable alternate call.
4. Both variants use identical frozen runner/backend/resource profiles and fresh
   disposable guest workspaces per attempt. Host grants must be explicit; they
   are never inferred from a candidate's requested capabilities. Initially reject
   host-policy/engine changes between variants to keep the comparison defined.
5. The evaluation controller owns these Harness instances and cannot obtain a
   mutable production Registry. The production importer receives only a sealed
   report and retained artifacts, and independently verifies its authority.

A directory called "evaluation" is not an authority boundary by itself. Construct
an opaque `EvaluationInstance` through the controller, creating its DB under a
trusted private root with no symlink/hardlink aliases; do not accept an arbitrary
production DB path as a bootstrap target. Do not expose the private harness or
bootstrap token to plugins/models or a public app-server command. Instance IDs,
registry provenance and evaluator owner epoch belong in the durable run record.
An evaluated manifest has the *same* content identity in both registries; only
eligibility/lifecycle records are local. Never import evaluator bootstraps.

This approach needs no `Harness::begin_unmeasured_call` or weakening of
`PinnedCall`. If a future shared registry is required, add a distinct evaluation
lease namespace and non-convertible `EvaluationCall`, rather than teaching active
production acquisition to ignore eligibility. That larger change is unnecessary
for this first implementation.

## Frozen contract and oracle

Introduce a controller-only `EvaluationPlanV1` with baseline/candidate generation
digests, evaluator artifact, actual controller build identity, selected plugin and
tool, runner/backend identity, host-grant digest, resource/time/output ceilings,
integer compute-rate units, total budget, repeats, deterministic paired order,
policy thresholds, and three corpus identities. Pin resolved immutable Docker
image ID or smolvm archive byte digest before scheduling, never a floating tag.
Record launcher/version and qualified isolation capability separately. No fallback
or pull is allowed. Set explicit limits on case count, JSON depth/size, attempts,
evidence bytes, concurrency (initially one), and aggregate reservations.

Keep two representations: public case inputs and a private oracle artifact. The
oracle includes unique IDs, lane labels and expected JSON; the guest receives
only the selected tool input, plugin bytes and already authorized dependencies.
No oracle, evaluator code, entire evaluation registry, policy file, provider key,
or production workspace is mounted or put in guest env/stdin. Do not put lane
names or expected answers into visible filenames. The host alone parses the RPC
result and applies an explicit versioned canonical-JSON equality rule (sorted
object keys, preserved array order, defined numeric semantics, bounded depth,
reject ambiguous duplicate keys). Test numeric cases rather than claiming
byte-for-byte TypeScript parity. RPC Error and malformed output are not matches.

Seal the complete plan before the first attempt and verify its retained bytes
again before scoring. Policy changes create a new plan/run; guest output cannot
supply decisions, counts, costs, durations, cleanup status, or receipt identity.
Reject duplicate IDs and canonical inputs across all lanes; also record fixture
family/provenance grouping to avoid near-duplicate families crossing partitions.
Development feedback may reveal only the predeclared development observations;
keep held-out inputs, answers, per-case outputs and detailed negative-control
results out of proposal feedback and general event streams. Protect private
oracle retention/access separately from a public report. Unsalted digesting of
low-entropy answers does not hide them: publish an opaque commitment or private
artifact reference, not an enumerable answer digest, outside the trusted store.

Repeated candidate selection can overfit even aggregate held-out decisions.
Predeclare a campaign query budget; consume final holdout once per frozen
selection, or rotate independently sourced partitions. Further trials on the
same corpus are stability checks. Operator-authorized thresholds determine a
fixture pass; tiny synthetic suites must not claim detection improvement.

## Attempt scheduling, accounting and recovery

Add a durable evaluation ledger owned by one fenced controller, following the
native engine's stable lock + SQLite owner-epoch pattern. Do not rely on the
in-memory runner task or evaluation-registry lease alone. Record the plan, exact
schedule, instance identities, attempt states, owner epoch, reservations, staging
recovery references, backend identity, raw bounded streams and settlement before
publishing an evaluation result. Use integer cost units with checked arithmetic.

An attempt key is `(run, variant, case, repeat)`. Persist admission/reservation
before launch; use a stable execution ID derived from a persisted attempt ID.
Exact command retries return the same state/result, never silently run again.
Distinct explicit reruns get a new run identity and retain prior evidence.
Schedule paired variants in alternating order. Require the complete expected
attempt matrix before any Eligible decision; missing pairs, cancellation,
unstable results, unknown costs, or uncertain cleanup produce Inconclusive.
Known valid outputs violating the oracle/policy produce Rejected. Preserve the
reason and completed evidence if the controller stops early.

Compute allowance is an operator-defined resource accounting estimate, not a
cloud invoice: reserve a documented upper bound spanning startup/execution and
cleanup, then settle with host-measured elapsed/resource data. Never present
`duration * configured_rate` as measured provider spend. A future provider lane
must use Engine inference reservations and real final usage/reconciliation;
Runner's offline subprocess cannot fabricate that accounting. Keep proposal,
evaluation-compute, and future inference budgets distinct. Unknown effects retain
a conservative hold; a pre-dispatch cancellation releases its reservation.

Runner currently creates a staging directory and starts its task before returning
`RunningCall`. For crash-complete recovery, introduce a two-phase runner API:
`prepare(harness, call, plugin, launch) -> PreparedRun`, exposing a verified
request/staging/execution identity without dispatch; then
`PreparedRun::start(cancel, sink) -> RunningCall`. Before start, persist the
owned lease, staging path, request digest and recovery identifiers atomically
with Running state. Preparation may write only beneath a controller-owned
attempt directory already persisted before it creates files. Crash between file
creation and ledger update remains discoverable through that owned directory.
A standalone pre-dispatch failure may safely release the lease after verifying
that no backend began. Do not expose a bare SandboxRequest as a replacement
execution permit or allow reusing a consumed PreparedRun.

On cancellation, stop scheduling, cancel the owned task, await terminal backend
cleanup, persist outcome/charge and then explicitly complete the lease. A task
panic or dropped waiter is not proof of cleanup. Confirmed backend disappearance
plus settled broker effects (none in v1) permits release and staging removal;
otherwise record Unknown, retain recovery paths/lease/reservation and refuse
eligibility. Restart fences the prior controller before touching its leases.
Previously admitted-but-not-started work becomes explicit not_started; Running
becomes Unknown with no automatic replay. Recovery checks concrete backend
identity, never kills by a stale PID alone. There is no lease expiry/disposal
inference from `RuntimeLifecycle::Inactive`. Use run/instance/owner epoch handles
even when the same generation digest is evaluated twice.

Persist terminal attempt outcome and budget settlement in one ledger transaction.
The private evolution lease is a separate DB: release it only after durable
settlement, then durably mark release. Crash between those steps is reconciled
idempotently after fencing. Never claim a transaction spans the two stores.
Publish the final report only after all required settlements; retained unresolved
leases block Eligible even if every observed output matched.

## Receipt and production import

Keep `EvaluationReceipt` as the existing registry envelope. Its `policy_artifact`
currently must equal the candidate's **host-grants policy**, not the new scoring
policy. Preserve that check. Store scoring-policy and plan digests in typed
observations and mandatory evidence entries; do not overload the existing field.
Pin an evaluator implementation artifact manifest containing the actual binary
hash, build/dependency lock identity, oracle algorithm version and accounting
version. A caller-supplied source label alone does not attest the running binary.

Required measured evidence binds: run ID; both generation/artifact closures;
private instance identities/epochs; exact plan and corpus commitments; evaluator
and backend identities; scoring policy; full scheduled-attempt index; per-attempt
input/output/effect-state/usage artifacts; cleanup and lease-settlement results;
unique-case lane scores, paired regressions, stability and every gate decision.
Retain raw bounded outputs as untrusted evidence. Distinguish invalid/unavailable
oracle execution from valid mismatches. On negative controls report exact-output
mismatch rate unless a frozen finding schema actually defines false positives;
any JSON mismatch is not automatically a vulnerability false positive.

Bound evidence by immutable chunk artifacts plus an indexed root (registry limits:
64 MiB per artifact, 1 MiB JSON receipt, at most 256 evidence references). A report
root is the hash of canonical envelope bytes; exclude its own hash from the input.
Record terminal status before returning that identity. Atomically import all
referenced evidence before recording the envelope; incomplete import is inert.

A separate trusted importer validates the report schema, evaluator allowlist,
complete evidence closure, every attempt and decision, and expected production
baseline/epoch. Only then may it call `admit_eligibility`. It must not accept an
arbitrary guest JSON Eligible receipt. Existing `admit_eligibility` is intentionally
low-level and is not a sufficient public measured-import endpoint by itself.
After import, activation still requires normal prepare/migration/CAS and policy
rollout approval. A baseline switch during evaluation makes this report stale for
that activation intent; rebase/re-evaluate explicitly. Rollback uses current-state
compatibility and retained code, not restoration of an old evaluation DB.

## Minimum implementation/API slices

1. New controller crate: validated immutable plan/private corpus, pure exact-JSON
   scorer, typed measured evidence manifest, bounded durable ledger and status
   pages. Creation takes a trusted private root and verified artifact exporter,
   never a mutable production Registry. Expose prepare/run/cancel/inspect/recover.
2. EvaluationInstance privately wraps the existing Registry/Harness bootstrap
   sequence. Add narrow artifact-closure export helpers only if copying verified
   plugin declarations is otherwise duplicated. No production bypass API.
3. Runner's prepare/start split and durable caller-selected attempt staging root,
   preserving instance-bound PinnedCall validation and owned cleanup behavior.
   If this split is deferred, label crash recovery incomplete and do not issue
   production-eligible reports from the prototype.
4. Pure measured-report verifier/import adapter, with separate explicit trusted
   authorization and expected production generation/epoch. Existing low-level
   receipt remains supported; measured qualification is not inferred from shape.
5. Add app-server/CLI evaluation commands only after ledger/cancellation and
   authority tests; no automatic rewrite or promotion loop in this slice.

## Required acceptance tests

- Unmeasured candidate runs only in its private instance; production epoch/state,
  eligibility and leases remain byte/semantically unchanged. Wrong instance call,
  forged pin, imported bootstrap and aliased production DB path reject.
- Missing/tampered artifacts, changed grants, dependency drift, unsupported source
  generation, cross-engine identity, floating backend or fractional smolvm CPU
  reject before dispatch. Both variants get identical launch limits.
- Guest inspection cannot find expected answers/lanes/controller DB/credentials;
  forged receipt stdout is merely a mismatching result. Callback and multiple RPC
  frames reject. Sentinel oracle bytes never occur in staged guest files/stdin.
- Exact oracle object-order/numeric/duplicate-key/depth semantics; malformed JSON,
  process failure, output cap, timeout and cleanup uncertainty are inconclusive.
- Per-lane unique-case counts, paired no-regression, alternating order, repeat
  instability, negative-control regression, missing final pair and held-out
  contamination/query-budget exhaustion prevent eligibility. Repeats never
  inflate independent sample count. Development feedback excludes hidden lanes.
- Budget exhausted before launch produces no runner start. Cancellation before
  dispatch releases hold; cancellation in flight awaits cleanup; uncertain cleanup
  holds resources. No fabricated zero charge for unknown elapsed execution.
- Crash/fault at every ledger/start/lease-release boundary; restart never replays
  Running, discovers retained paths/leases, requires fencing and preserves exact
  retries. A release-after-settlement crash reconciles idempotently.
- Receipt substitution (candidate/baseline/engine/backend/oracle/scoring policy),
  missing/tampered evidence, unknown evaluator and stale production epoch reject.
  Successful measured import still does not activate the candidate.
- Offline deterministic fake backend tests qualify logic only. Opt-in tests on
  already-local Docker/smolvm artifacts qualify actual guest separation,
  cancellation and cleanup for that backend. No image pulls, paid providers or
  live-target scans are prerequisites.

A passing implementation demonstrates measured behavior on the declared fixtures
and native offline execution lifecycle. It does not demonstrate autonomous source
rewriting, general vulnerability-detection lift, production rollout readiness,
held-out independence merely from a label, or superiority to another scanner.

## Implemented foundation checkpoint

`crates/zero-evaluation` now implements the private per-variant registry approach,
frozen plan and separate scoring-policy digest, runner prepare/start ordering,
SQLite intent/outcome records, stable owner lock, retained admitting owner epoch,
restart Unknown/no replay, complete paired exact-value scoring and report integrity
recomputation. Ten default tests exercise actual runner subprocess fixtures. An
opt-in local Docker test executed twelve Node fixture attempts and verified all
leases settled with the source registry unchanged; it did not pull an image.
This checkpoint did not run an evaluator-level smolvm qualification test.

The implemented oracle uses serde_json Value equality and the runner's JSON parser
semantics, not the proposed duplicate-key-rejecting canonical parser. Accounting
is reserved execution slots with frozen time/output ceilings, not monetary usage.
Report Eligible is fixture qualification only: no production eligibility importer,
portable/redacted evidence export, independently attested evaluator binary,
automated fenced cleanup, campaign holdout-query enforcement, canary rollout,
provider evaluation or autonomous source rewriting is implemented. The host must
supply corpus provenance and prevent adaptive held-out leakage. Private directory
permissions do not isolate the oracle from a malicious process sharing the host
account. The crate README is the precise supported API/qualification contract.
