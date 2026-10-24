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

## Genuine local-model protocol observation

A separate `local-model` adapter runs only against
`http://127.0.0.1:11434`, rejects redirects and checks the exact installed manifest
before and after every inference. It never calls a model-pull endpoint, accepts
credentials or selects another model. Existing Safetensors were imported using
[Ollama's documented local import](https://github.com/ollama/ollama/blob/main/docs/import.mdx).
No weights, Python model code or new inference stack were downloaded.

The measured source is `Qwen/Qwen3-0.6B` at revision
`c1899de289a04d12100db370d81485cdf75e47ca`; the 1,503,300,328-byte weights hash is
`sha256:f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b`.
The installed Ollama 0.40.6 MLX manifest is
`sha256:94f66e7628259ecc39cb2fc0eb6b81a51fc2ebe5d586c7d01f52f5dc94df9346`.
`local-plan.json` reserves at most 16 inference calls, 70,000 total tokens and
120 seconds, with a 4,096-token context and 256-token output bound per call.
Each next call reserves its worst-case context/output allowance before dispatch.
The local plan's USD cap is zero external API fee; it is not a compute-dollar
limit. Machine, energy and opportunity costs remain unknown.

```sh
node packages/cli/dist/index.js routing-qualify \
  --plan docs/qualification/task-routing/local-plan.json \
  --out /tmp/local-task-routing.json
```

The model must already exist with the pinned manifest; missing or changed models
stop without downloads or fallback. The command exits nonzero for an inconclusive
panel while retaining its report. This observation uses only synthetic
protocol/task-state controls: no public-vulnerability workloads, exploitation,
#120 study or #121 experiment were run.

Two genuine local observations are retained, including the earlier rejected
attempt rather than discarding it:

| Receipt | Inference calls | Input/output tokens | Panel wall time | Median inference time | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `local-report-attempt-1.json` | 8 | 2,872 / 1,228 | 10.475 s | 1.107 s | 8 inconclusive tool-protocol gates |
| `local-report.json` | 8 | 2,872 / 1,228 | 9.423 s | 1.031 s | 8 inconclusive tool-protocol gates |

All 16 local inferences are accounted for. No required `read_fixture` roundtrip
completed, so downstream task quality was not evaluated. These results do not
separate imported-template compatibility from small-model behavior and do not
establish general model incapability. They do establish that this tested
model/runtime route is not qualified for the required tool protocol. No route
recommendation or passing security-efficacy claim follows from these results.
The first receipt retains an earlier required USD placeholder of 1; it was never
a measured charge or a local-compute cap. The final local schema explicitly
requires zero external API budget.

The runtime reported 1,412,882,448 resident model/VRAM bytes for both observations.
Client peak RSS was 302,544 KiB and 301,632 KiB respectively; those values describe
the CLI process, not server RSS. Per-call server durations, load/prefill/generation
measurements and client CPU time are retained in the reports. Metadata resource
sampling shares the remaining wall-clock allowance. External API fees were zero;
compute dollars and energy are unknown, not free. Local observations remain
ineligible for the provider-backed production selector.
