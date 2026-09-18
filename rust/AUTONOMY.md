# Agent choice and independent evaluation

The agent chooses its hypotheses, experiments, task decomposition, delegation
and stopping point. Host controls retain authorization, spending/resource
ceilings, cancellation and trusted verification semantics. Self-evolution may
improve choices; it cannot declare its own changes successful.

## Current boundaries

The native loop already lets the model choose HTTP requests, tool order, allowed
roles and delegated task prompts, and early completion. Maximum turns, parallel
children and tool limits are ceilings, not instructions to exhaust them. An empty
web submission means no submitted hypotheses, never that a target is safe.

With opt-in `web_experiment_policy`, `run_web_experiment` retains a provisional
hypothesis and freezes the agent's selected bounded requests. Fresh effects
return measured observations to the same active actor. The model can revise,
abandon, delegate, test again or stop without exhausting its allowance. Ordinary
HTTP observations remain available. Existing final reviews stay immutable and
terminal, and external host-authored verification remains separate.

Experiment admission and its original-account quota commit together. A gated
matrix consumes one exact approval in the same transaction. Failure, cancellation
and restart never refund an experiment admission. Prior revisions require causal,
retained hypothesis evidence from the investigation's authorized lineage.

Model-authored expected responses are predictions. Matching one can establish
`ObservedForPlan`; it does not establish a vulnerability or an improvement in
agent quality. Trusted security/evolution criteria, negative controls, identity
requirements and evaluator versions belong to separate host authority. A second
model agreeing with a narrative is not a substitute for those boundaries.

## Spending, resource limits and cancellation

Model reservations are shared by the existing session and checked atomically
before dispatch. They are admission estimates: actual charges can exceed a
caller-supplied reservation, must remain visible, and block later admissions.
Unknown usage retains its hold. Do not advertise a guaranteed invoice ceiling
without a supported conservative billing bound or provider-enforced cap.

HTTP children, continuations, adaptive experiments and linked verification share the original root's
request/byte account, rate limits and cooldown. A new independently authorized
root creates a new account. Inline experiments inherit the original account;
strategy campaign roots additionally share a durable campaign account and cannot replenish it. The model currently
has no tool granting session creation, account replacement or reconciliation.

Sandbox limits and evaluator execution slots are separate from model money.
Strategy campaigns bind fresh evaluation roots to a durable identity and aggregate
model, HTTP, experiment and run quotas. Reservations and actual charges remain
distinct, deadlines constrain admission, and uncertain usage retains its hold.
Candidate-generation and canary integration must preserve this same account;
creating a campaign per autonomous proposal would defeat the aggregate limit.

Cancellation means signal, drain owned work, then report its known disposition.
An accepted cancel signal is not a rollback or proof that billing stopped.
Restart must not replay uncertain requests. UI snapshots are advisory and must
not be used for admission decisions; active budget snapshots need truthful age
and refresh behavior.

## Self-evolution

Existing plugin evaluation measures actual offline fixture outputs against host
expectations. It does not yet evaluate an agent's full investigation decisions.
The generation registry accepts trusted host-authored receipts; hashing a receipt
does not prove an approved evaluator ran. Never expose eligibility/activation
mutation as a model tool or accept candidate-authored success flags as evidence.

The first strategy campaign changes a bounded advisory strategy artifact
while keeping scope, tools, models, snapshots, evaluator, oracle and promotion
policy fixed. Run actual baseline/candidate agents on host-owned scenarios;
measure supported observations, controls, stability, retained baseline capability
and cost independently of the candidate's prose. A cheap empty report is not
necessarily improvement, and repeated cases are stability checks rather than
new independent samples.

Candidate generation receives development feedback only. Freeze scenario-family
splits and retain holdout exposure before execution; crashes do not restore an
exposure. Reusing a test set after observing its verdict is adaptive reuse, not
fresh independent qualification. Independent canary evidence requires a separately
committed population; repeating the same suite proves only repeatability.

Promotion requires independently recomputed evidence from a trusted evaluation
ledger, the supported artifact kind, current baseline and epoch, and the host's
activation policy. Such a policy may permit unattended activation; it does not
require a new universal approval ritual. Existing sessions keep their captured
strategy. Rollback preserves current state, history and spend rather than erasing
failed attempts.

## Implementation order

1. Qualify the opt-in nonterminal experiment loop inside the current owned
   investigation, including shared monetary/HTTP authority, durable experiment
   quota, repairable input rejection and retained uncertainty.
2. Add campaign accounting and real agent-strategy evaluation, protected final
   exposure, development-only feedback and a measured eligibility bridge.
3. Qualify autonomous candidate generation, separate canary, activation and rollback
   before broadening the writable artifact surface or claiming measured improvement.

The experiment loop implements the first boundary. The campaign controller runs
actual baseline/candidate agents against local HTTP fixtures, with separate
Development and Final commands, permanent protected-suite exposure, independent
retained-evidence scoring and read-only reports. Reports are explicitly
`qualification_only`: `ImprovedForFixtureSuite` does not grant eligibility,
activation or a general security-quality claim. Private fixture truth stays out
of agent instructions; feedback exposes Development cases only. Protected suite
identity is canonical across scenario ordering and independent of candidate and
Development changes. Host-authored suite contents still need corpus governance. Renderer and oracle
identities are explicit semantic versions, not binary attestations; changes to
compiled evaluation semantics require a version change.

This adapter supports snapshot-free HTTP actors and optional HTTP delegates;
source/sandbox candidates, autonomous proposal generation, independent canaries,
autonomous activation orchestration remain unfinished. Scanner, browser/auth/session, cloud, arbitrary source
self-rewriting and production release parity remain in [MIGRATION.md](MIGRATION.md).

## Captured runtime and measured eligibility

An explicitly installed initial strategy is a trusted, unmeasured baseline.
Strategy sessions capture its exact advisory, generation, epoch and host authority.
Actual model requests render that capture; raw inference, altered instructions and
unsupported queue admission cannot bypass it. Delegates inherit the same capture.
Already-owned work finishes under its original strategy across a switch. Fresh work
on a stale session fails; a new session captures the new active strategy. Exact
completed retries need neither current provider credentials nor a fresh dispatch.

Registry-bound campaigns freeze baseline/candidate identity before evaluation.
Only an independently recomputed, complete, observed, improved campaign can import
measured eligibility. Import checks current registry identity, baseline epoch,
state, authority and advisory-only change. The original source ledger is required
for first import; portable evidence alone cannot create initial authority. Atomic
import retains bounded evidence for offline reassessment and exact retries after
source deletion. Corrupt retained evidence cannot authorize activation.

Protected-suite exposure is permanent within the source Store. Registry-wide suite
uniqueness prevents another measured grant, including after deletion of its import
projection. This does not establish unseen holdouts across copied or independently
administered source databases; corpus governance remains host-owned.

Import does not activate a candidate. The host Harness can activate measured
eligibility under its frozen policy, and this path is tested with real paired
fixture evidence and an actor running across the switch. A policy requiring canary
evidence remains blocked until separately qualified evidence exists. Autonomous
proposal generation, canary orchestration and the candidate activation CLI remain
unfinished. Writable artifacts remain bounded advisory text, not host policy or code.
