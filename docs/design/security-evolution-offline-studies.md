# Bounded security evolution studies

Status: implementation and deterministic fixture qualification only. No paid
security pilot has been run by this change. Issues #120, #121 and #122 require
measured security outcomes; none is evidence of an optimizer benefit today.
Production promotion rules, scan prompts, proposal width and scan call counts
remain unchanged. These modules have no imports from ordinary scan paths.

## Basic pilot (#120)

`packages/core/src/bench/security-evolution-pilot.ts` adapts the existing trusted
`runBenchCase` / `ObjectiveOracle` path rather than giving a generated candidate
provider credentials or network access. An operator supplies a trusted `PilotScan`
wrapper around the selected existing benchmark/provider adapter, independently
curated vulnerable/fixed/clean family labels and a preregistered `PilotPlan`.
The wrapper must enforce `ceilingUsd` before provider dispatch, preserve the
existing networkless candidate boundary, and return actual model and compute
charges even on failure. An estimated scan cost is insufficient billing evidence.
Missing billing, floating model identity, identity drift or authority/evidence
invariant failures stop dispatch and yield an inconclusive report. Reconcile an
indeterminate provider call before retrying; this supervised adapter does not
claim durable unattended crash recovery.

The explicit plan requires frozen baseline, width-one sequential, A/A and injected
regression arms; include a budget-matched `baseline-extra-attempts` arm when
appropriate. Bind source/image bytes, evaluator, resolved provider/model, decoding
and harness digests. Source/image identity must match within each paired case;
provider/model/evaluator/decoding identity must match throughout the study.
Each arm's harness bytes must stay fixed. One target-kind/objective workflow is
allowed per pilot. Target provisioning remains the existing trusted provisioner.

Call `preflightSecurityPilot(plan, manifest.cases.length)` before any dispatch.
Its estimate reserves complete final validation capacity plus a common search
allocation for every arm. Supply all proposal/build/summary charges, including
rejected attempts, in `searchCharges`; `[]` explicitly records a no-search arm.
The adapter runs independent repeats in interleaved case/repeat/arm order. It
retains case-level oracle verdicts, labels, identities, invariant decisions,
actual charges and end-to-end timing. Its summary includes false alarms and
inconclusives, and suppresses p95 below 100 observations per arm. This conservative
support threshold is descriptive, not a confidence claim. Search latency should
also be recorded by the enclosing campaign; the report's elapsed time starts at
evaluation and does not pretend to include work already done before invocation.

The preregistered protocol must specify family splits, paired analysis, practical
quality/false-alarm/retention margins, minimum evidence and independent adjudication
before final outcomes are observed. Use #37 retention and #38/#40/#41 provenance,
exposure and campaign accounting in the enclosing study. Final holdout evaluation
is deliberately not dispatched or exposed by this adapter. Analyze A/A false
rejections, injected regressions, retention, quality and opportunity cost under
that protocol; this report never automatically promotes a harness or declares a
statistical win. Report insufficient precision as inconclusive. Break-even volume
is justified only after a positive, adequately supported per-scan saving.

`estimateEvolutionExecutions()` reproduces the default 540-worker load, or 1,620
for three complete candidates. These are execution counts, not measured dollars.
No paid provider is invoked by the deterministic unit tests.

## Development feedback ablation (#121)

`packages/core/src/improvement/development-summary.ts` supplies an explicit offline
`DevelopmentSummaryCache`. It accepts existing `EvolutionAttempt` observations;
only `development` observations are admitted. Raw stdout/stderr and case names
never enter its prompt projection. Private lanes are excluded before hashing.
Groups distinguish preserved successes, incomplete coverage, setup failure and
unknown outcomes. Repetition/evidence-failure/confirmed-miss categories require a
controller-owned verifier receipt digest, never a model's causal explanation.
A digest is a reference for independent controller adjudication, not proof by
itself. The caller must authenticate and retain that verifier receipt.

Declare case, observation, example, byte, conservative token and cache caps before
evaluation. The iterable, including malformed/private observations, is bounded;
raw traces are never scanned or copied. Cached semantic receipts skip regrouping
and prompt construction; ingest still performs bounded lane filtering and identity
projection. Opaque trace references are reproducible from the controller's original
case/repeat/category/verifier tuple, which remains in its audit store. Truncation
is explicit; a truncated summary is never a claim of complete failure coverage.

Only after a qualified basic pilot, compare raw sequential feedback versus this
summary under equal proposal and total search allocations with width and parent
policy held fixed. The pilot rejects a combined summary/diversity arm. Record
quality, false alarms, retention, proposal tokens, all search costs and deployed
artifact latency. The summary is not wired into production prompts. A negative or
unresolved outcome keeps existing feedback.

## Proposal diversity ablation (#122)

Execution remains gated on the qualified basic pilot. The standalone
`proposal-diversity-study.ts` implements deterministic development shortlisting
for an explicitly bounded width (maximum eight), concurrency, retained bytes,
spend and execution count. Compare it against width one with the same parent,
feedback, editable surface and total search allocation. Every proposal supplies a
bounded hypothesis, observed-failure reference and risk. Equivalent edits are
rejected but their costs remain charged. Unknown usage and exhaustion of reserved
independent validation capacity fail closed. The selector chooses one candidate;
it combines no patches and grants no activation. The enclosing trusted campaign
must enforce concurrency and reserve capacity before generation, not merely call
the selector after spending. This is study tooling, not a replacement optimizer.

Archive-parent selection (#39) is a separate arm, as is summary feedback. Do not
combine them before their individual benefit is measured. Include unsuccessful,
null and inconclusive campaigns. No default expansion is justified by a branch
count, mocked success, concurrency or mere completion of these fixtures.

## Reproduce deterministic checks

From `packages/core`:

```sh
pnpm exec vitest run src/bench/security-evolution-pilot.test.ts src/improvement/development-summary.test.ts src/improvement/proposal-diversity-study.test.ts
```

Remaining evidence: actual labelled corpus and immutable runtime identities,
provider-enforced billing caps and reconciled charges, preregistered stochastic
protocol, finite supervised paid runs, retention/exposure accounting, untouched
independent final validation, instrumentation overhead and deployed latency. Until
that evidence exists, the research issues remain open and all ablations disabled.
