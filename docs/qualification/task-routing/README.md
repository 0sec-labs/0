# Task-routing qualification contract

Issue #54 adds an opt-in, bounded policy; no ordinary scan calls an evaluator or
silently enables model routing. Existing historical
[model comparisons](../../src/content/docs/research/model-comparison.md) supply
candidate ideas only. Those few XBOW trials do not establish the best model for
reconnaissance, validation or reporting. Defensive/CTI specialization, coding
ability and lower refusal rates are distinct observations; none substitutes for
passing the selected task and evidence controls. Operator-approved provider
connections and workflow authorization remain required.

The initial controller policy is deliberately small: retain only explicitly
approved models that pass every declared task control and curated tool roundtrip
for the selected workflow; among eligible models choose the lowest aggregate
catalog-estimated cost for that task, breaking ties by observed latency and model
ID. Each task has one positive and one negative synthetic control, repeated as
specified. A passing tiny panel establishes that panel's behavior, not broad
security superiority, statistical significance or independent final efficacy.
A recommendation can map every task to the same model. The policy never rewards
refusal reduction by itself.

## Reproduce the protocol and negative controls without API spend

After the normal workspace build:

```sh
node packages/cli/dist/index.js routing-qualify \
  --plan docs/qualification/task-routing/fixture-plan.json \
  --out /tmp/task-routing-fixture.json --regress-model gpt-4o
```

This invokes the registered CLI command and real qualification/budget adapters.
The deterministic controller adapter uses the model names only as labels; it
makes no provider calls and measures no live model quality. Every task performs
an isolated `read_fixture` tool-call/result roundtrip. The response must preserve
`fixture://authorized/panel`, the evidence reference and exact controller-defined
validation state. The deliberately regressing label changes validation states
and must fail. There are four tasks: authorized route inventory, source owner
checks, independently grounded verification and evidence-preserving reporting.
Each includes a negative control. Opaque case IDs disclose no expected label.
Expected answers remain controller-side.

One plan with two labels and two repeats reserves 64 calls and produces 32 trial
receipts. Every successful fixture call reports 100 input/10 output tokens;
therefore aggregate usage is 6,400 input/640 output fixture tokens. Recorded
costs use the labels' catalog tariffs and are simulated estimates, never invoice
charges. Both labels share a deadline, call counter and estimated-spend ledger.
Provider error, malformed output, missing usage, unavailable model and limit
termination remain explicit failures/inconclusives. A missing usage receipt
stops later dispatch and yields unknown total cost. In-flight charges may exceed
the estimated threshold. Fixture evidence is rejected by the production selector.

## Provider-backed panel and reviewed use

Copy the plan, select explicit accessible models, set `mode` to `model-api`, and
review total call/time/estimated-spend limits and the provider's authorization for
this synthetic workflow. `routing-qualify` refuses provider dispatch unless
`--allow-provider-calls` is also supplied. Credentials come from the current
approved connection; no keys are stored in the plan or report. Forked models
must resolve to the requested IDs; unavailable models stop without substitution.
Unknown tariffs stop before provider dispatch; the report records the catalog
pricing snapshot and rejects reports from a different snapshot. The report
records resolved provider/model labels, per-task elapsed time, tool
and evidence invariants and provider-reported token usage. Actual invoice charges
and immutable provider model revisions remain unavailable unless independently
reconciled; aliases are not proof of a pinned version. Requalify after provider,
model version, tool contract or suite changes.

Review the report, including failures, scope and model-identity limitations,
before selecting it in an interactive scan:

```sh
0 scan --target https://your-authorized-target --runtime api \
  --routing-report /path/to/provider-report.json \
  --routing-model FIRST_APPROVED_MODEL --routing-model SECOND_APPROVED_MODEL \
  --routing-review-ref REVIEWED_PROVIDER_WORKFLOW_AND_MODEL_EVIDENCE
```

The review reference is an operator attestation, not automatic proof of provider
terms or restricted cyber-program workload permission. Credentials alone never
authorize a recommended route. Recommendations require the same provider and
exact target-kind/goal/depth contract, the current suite and evaluator-function/schema digests, at least two
repeats, complete distinct positive/negative case coverage and no unknown usage.
Evaluator digests are conservative and can reject reports across different
compiled/source builds; qualify and consume with the same built CLI artifact.
A failed/incompatible report stops with a concrete reason; no route is silently
substituted. Task assignments and reasons appear after goal/depth selection and
before confirmation. `--task-model ROLE=MODEL` overrides individual assignments;
`--single-model` retains one-model consistency. Noninteractive reviewed routing
also requires explicit `--goal`, `--plan-time-cap` and `--cost-ceiling`.

Reports are bounded to 2 MB and finite panels. They contain no fixture source,
full model histories or credentials. The reader assumes operator-reviewed local
artifacts; it does not authenticate external benchmark claims. Do not accept an
untrusted report as provider authorization or evidence of model efficacy.

## Evidence status

Committed fixture receipts demonstrate CLI plumbing, shared accounting,
protocol enforcement and deliberate regression detection only. Paid
representative security-workflow qualification, actual-charge reconciliation and
independent generalization evidence remain separate. No default is enabled on
the strength of these fixtures.

The confirmed scan plan now owns the root workflow wall-clock deadline independently
of `--timeout`, which continues to bound individual requests. The legacy timeout
remains the whole-workflow fallback when no plan is supplied. A regression keeps
a multi-task plan alive beyond one request timeout without increasing individual
request allowances.
