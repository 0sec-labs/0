# Bounded same-parent proposal-width study (#122)

This experiment is deferred/not planned as an active commitment. #122 is
consolidated as a conditional hypothesis in #120; reopen only after a useful basic
pilot and an observed search bottleneck justify one separate finite comparison.
The controller is retained, with no demonstrated model-backed benefit. It reuses
#199's bounded search lifecycle and native metered model/snapshot/evaluator
adapter. The existing pure `shortlistDiversityStudy` helper and its public API
remain available; the new campaign module supplies the previously missing
proposal/build/development/final execution lifecycle. It neither adds scan-time calls nor enables default worker fan-out.

## Variable and held-fixed conditions

`runProposalDiversityStudy` compares width one against an explicitly selected
width two or three. Every seed/arm uses the same immutable parent, editable
surface, initial development feedback and feedback representation. Each wider
cohort receives the same parent and feedback before development feedback advances.
Candidates are dispatched sequentially (concurrency one), so width is not being
confounded with a concurrency or latency optimization. Candidate-byte digests
reject equivalent edits deterministically, after charging their proposal cost.

Every proposal includes a bounded hypothesis, observed failure, changed surface
and risk. Rejected proposals/builds and unsuccessful screens remain in the cost
report. Only the highest development score selects one artifact for a complete
independent final panel; no private score changes that shortlist. Ties retain the
first candidate. There is no patch combination or combinatorial search. The same
host-owned native adapter in #199 enforces source inventory/noneditable bytes,
proposal editing, trusted billing and the shared final exposure ledger.

The budget is equal **total allocated spend**, executions and per-task ceilings,
not generations, number of evaluated proposals, or a claimed cost saving from
parallelism. Actual spend is reported separately. Unknown usage, budget drift,
identity drift and incomplete operations stop the whole study for reconciliation.
Final validation dollars/executions are reserved before search. Output records
verified quality, false positives, critical retention, all rejected/search/build/
evaluation costs and end-to-end latency, including inconclusive campaigns.

## Strict prerequisite

The real runner requires an immutable #120 provider-backed pilot report plus an
independent review reference. It rejects a control-only, negative or inconclusive
pilot; missing actual provider/compute invoices; unknown usage; floating model or
decoding identities; insufficient independent families; a retention regression;
an undemonstrated regression control; or a paired interval that does not establish
positive basic-pilot benefit. The report digest binds the original report.

The current #120 micro-study honestly reports limitations such as unreconciled
provider invoices and provider-default decoding. Such a report is **not** a wider
search qualification. Do not change its conclusion or manufacture pinned fields
to bypass this gate. A qualified report requires new reconciled measurements and
review. Summary-feedback (#121) and wider-proposal experiments must be evaluated
separately before proposing a combined arm.

Real dispatch also requires an explicit approved spending cap covering both arms,
all paired seeds and complete independent final validation. The CLI validates
these prerequisites before importing a trusted adapter, so rejected plans do not
instantiate a provider. No paid call was made for this PR.

## Reproduce controller controls

```sh
pnpm install --frozen-lockfile
pnpm --filter @0/shared --filter @0/db --filter @0/templates --filter @0/llm-redteam build
pnpm --filter @0/core build
node scripts/run-proposal-diversity-controls.mjs --output /tmp/diversity-null.json
node scripts/run-proposal-diversity-controls.mjs --inconclusive --output /tmp/diversity-inconclusive.json
pnpm --filter @0/core exec vitest run src/improvement/proposal-diversity-campaign.test.ts src/improvement/proposal-diversity-study.test.ts
```

Committed artifacts under `docs/qualification/controls/diversity/` reproduce the
null and unknown-usage controls. Their prices are deterministic fixture inputs
and latency is a deterministic test clock; they are **not** model quality, paid
spend, or performance measurements. Four paired seeds compare width one/three
with the same parent and a $0.20 fixture allocation per trial. Duplicate and
rejected-build costs count. The null control retains width one. The unknown-
usage control dispatches once, then records every remaining arm/seed as
inconclusive without another call. Tests reproduce the artifacts byte-for-data.

## Run a qualified provider-backed study

After genuine pilot qualification and spending approval, supply an existing
budget-bound native adapter through a trusted module exporting `createAdapter`.
For example, its factory can return `createModelSearchStudyAdapter` from #199
using curator-owned disjoint search/final configs, admitted immutable snapshots,
a provider-side bounded `proposalDependencies(dispatch)` factory and independent
`observeBilling` observations. Never pass source-controlled code as an adapter.

```sh
node scripts/run-proposal-diversity-study.mjs \
  --plan preregistered-search-plan.json \
  --pilot-evidence independently-reviewed-pilot-evidence.json \
  --parent immutable-baseline-version \
  --width 3 \
  --feedback development-feedback.txt \
  --approved-budget-usd 20 \
  --adapter /trusted/controller/study-adapter.mjs \
  --output proposal-diversity-report.json
```

The example cap is illustrative, not approval to spend it. The plan is the
`SearchStudyPlan` contract in #199. Pilot evidence contains the complete report,
its content digest, independent review reference and the preregistered minimum
independent families. Required pinned runtime evidence and reconciled costs are
additional evidence, not values inferred from an alias or a token-rate estimate.

Both the null control and any negative/inconclusive paid study retain the simpler
width-one approach. Reports always set `decision: retain-default` and
`automaticPromotion: false`. Even a positive result requires separate review of
the predeclared primary objective, full costs, false alarms, retention and complete
independent final validation before any default change. The committed controls
provide no justification for such a change.
