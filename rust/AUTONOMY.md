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

The current structured web path retains hypotheses at terminal submission.
Independent frozen-plan execution happens after that investigation ends. This
prevents a formal experiment/result/revision loop inside the same active actor,
even though ordinary HTTP observations already inform later model choices.

The next capability is an opt-in nonterminal experiment tool: atomically retain
a provisional hypothesis, freeze the agent's selected bounded requests, execute
fresh effects and return measured observations. The model can revise, abandon,
delegate, test again or stop. It must not fabricate a completed review to reuse
the external verification path or recursively start public Engine commands.
Existing final reviews stay immutable and terminal.

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

HTTP children, continuations and linked verification share the original root's
request/byte account, rate limits and cooldown. A new independently authorized
root creates a new account. Inline experiments must inherit the original account;
a future controller cannot start new roots to replenish it. The model currently
has no tool granting session creation, account replacement or reconciliation.

Sandbox limits and evaluator execution slots are separate from model money.
Before autonomous evolution or multiple experiment roots, add a durable campaign
identity and aggregate work quotas, binding proposal, candidate, evaluation and
canary runs. Preserve distinct units, uncertain reservations, deadlines and
actual usage. Fresh candidates and restarts cannot reset campaign limits.

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

The proposed first strategy campaign changes a bounded advisory strategy artifact
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

1. Add nonterminal agent-chosen experiments inside the current owned investigation,
   sharing its monetary/HTTP authority and a durable experiment quota. Return
   repairable input rejection without effects; never treat uncertain effects as
   a retryable argument error. Keep external independent verification available.
2. Add campaign accounting and real agent-strategy evaluation, protected final
   exposure, development-only feedback and a measured eligibility bridge.
3. Qualify autonomous candidate generation, separate canary, activation and rollback
   before broadening the writable artifact surface or claiming measured improvement.

These are implementation requirements, not claims that the proposed capabilities
are already complete. Scanner, browser/auth/session, cloud, arbitrary source
self-rewriting and production release parity remain in [MIGRATION.md](MIGRATION.md).
