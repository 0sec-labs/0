# Fixed-budget archive-parent study (#39)

Status: executable controller controls and a provider-backed adapter integration.
No paid efficacy campaign has been run. The production default remains unchanged.

## Existing implementation and guarded admission

The production evolution loop already retains version ancestry, immutable source
snapshots, compatible development feedback, and rejected candidates. Its opt-in
`maxAlternativeParents` selector ranks a bounded recent archive by development
match fraction. Archive membership never implies canary eligibility or activation.

`admitEvolutionAlternativeParents` now shares the exact snapshot, receipt and
feedback-contract admission path between that selector and offline studies.
Older versions must have the same source inventory as the active snapshot, and
noneditable bytes must match. This closes an implicit resurrection path: an old
parent cannot restore a deleted file or roll back protected source merely by
serving as the base of an otherwise allowlisted edit. Changing editable bytes
still requires the ordinary proposal validation and independent evaluation.

`runRegisteredArchiveSearchStudy` loads the authoritative registry, verifies
current development evidence against active source bytes, and admits at most
nine older versions. It exposes only development projections and opaque parent
IDs to `runArchiveSearchStudy`. The descriptor is the set of development cases
solved on every repeat; novelty means solving a case the current parent fails.
The three paired arms are `current`, seeded `uniform`, and
`development-diversity` (novel cases, then development fitness). Uniform selection
uses seeded hash ordering, so caller array ordering cannot select the winner.

## Reproducible controls

```sh
pnpm install --frozen-lockfile
pnpm --filter @0/shared --filter @0/db --filter @0/templates --filter @0/llm-redteam build
pnpm --filter @0/core build
node scripts/run-archive-study-controls.mjs --output /tmp/archive-aa.json
node scripts/run-archive-study-controls.mjs --regression --output /tmp/archive-regression.json
pnpm --filter @0/core exec vitest run src/improvement/paired-search-study.test.ts src/improvement/search-study-model-adapter.test.ts src/improvement/alternative-parent.test.ts
```

The committed reports under `docs/qualification/controls/archive/` come from
these commands. Every field is explicitly labelled a deterministic controller
control. Their dollar amounts are fixture inputs, not provider invoices, and
latency uses a deterministic test clock. They test accounting/reporting behavior,
not cybersecurity performance or model-search efficacy.

Each control runs four paired seeds, three policies, four proposals per trial,
a duplicate proposal, a rejected build, development screening, then a single
independent final panel. All proposal costs remain charged, including equivalent
edits and rejected builds. The A/A control has zero paired quality differences.
The regressing control offers higher aggregate quality with a false positive and
a critical retention loss. Both retain the existing default. Tests also ensure
unknown charges halt the entire study before another arm can dispatch.

## Paid preregistration and adapter contract

Before any paid call, fix the protocol reference, independent seeds, source and
model identities, editable surface, archive contents, development feedback format,
primary objective, per-arm **total spend** ceiling, total worker executions,
proposal cap, retained-byte cap and final validation reserve. Use the same initial
archive, ceilings and per-task limits in every arm; generations are not a budget.
Family-grouped final cases must be independently curated and disjoint from all
search inputs. Do not interpret seed strings as proof of independent sampling.

`runPairedSearchStudy` performs sequential bounded dispatch, charges actual
`PilotCharge` records from #120, and records all rejected/inconclusive outcomes.
Its callbacks receive a dispatch ceiling, execution cap and remaining retained
bytes. It refuses to begin search unless a complete final panel is reserved, and
never sends final results back to a proposer. Width is one in this study.

`createModelSearchStudyAdapter` connects this lifecycle to the existing
`proposeEvolutionEdits`, `createEvolutionCandidate`, networkless sandbox and
`evaluateEvolutionCandidate` implementations. Search and final use distinct
operator-owned configs and authoritative campaign stores; the final config never
enters proposal context. Every seed/arm shares one final store and its finite
holdout exposure ledger, rather than resetting exposure through per-arm stores.
The final contract must declare a versioned critical retention panel. The adapter preserves durable reservation/settlement,
source-edit restrictions and model usage checks. Builds run inside bounded
sandbox executions and are included in their compute charge; no extra host build
is launched. A required `proposalDependencies(dispatch)` factory binds a provider-side
request cap; an injected sandbox can be supplied by the #120 provider adapter.
A required `observeBilling` callback supplies independently observed actual
provider/provisioner charges and immutable receipt digests. Missing invoices
stop the study; rate-table estimates alone are not accepted as actual spend.
If observed billing differs from a legacy proposal/final rate settlement, the
actual charge is reported and the ledger is blocked for reconciliation. Tests exercise the complete integration using mocked provider
usage and deterministic sandbox executions without making a paid call.

Real provider/sandbox adapters are trusted controller code. They must enforce the
dispatch ceiling before issuing external requests, return actual billing on
failures, and supply a host-observed pinned `PilotIdentity`; a requested alias is
not immutable model evidence. The legacy proposal runtime checks dollar ceilings
after responses, so it requires a provider-side bounded callback for a hard cap.
Do not run an unbounded default runtime and describe post-call checks as a hard
provider limit. Unknown calls or partial snapshot failures stop the study for
ledger/storage reconciliation; they are never replayed blindly or counted free.

The registry entry point requires a trusted actual billing observation and immutable
receipt digest for the complete initial archive campaign. It reports recorded
proposal/evaluation costs separately; those legacy rate-based entries alone are
not actual invoice evidence. Initial-archive billing is separate from marginal
trial spend. Include the complete
original campaign ledger (earlier ancestors, rejected/unrecorded calls, initial
builds and any extra curation compute) in a published full-cost comparison. The
fixed archive is shared initial state, not newly free optimization. New store
paths are not a global holdout-exposure boundary: use the authoritative #40/#41
campaign protocol and do not reset exposure by copying a corpus to another store.

## Reporting and decision

Reports include per-seed chosen parent, proposal/rejection/duplicate counts,
actual known and unknown spend, worker executions, retained bytes, end-to-end
latency, final verified quality, false positives and retention. Per-policy tables
report median/best quality and paired quality differences with conservative
Hoeffding 95% intervals for independent differences in `[-1, 1]`. These broad
small-sample intervals are descriptive, not a model-efficacy result or correction
for adaptive holdout reuse. Inconclusive/missing pairs remain visible and are not
imputed as successes. Final provider/source/evaluator/decoding identities must
match across paired executions; candidate harness digests may differ.

There is deliberately no automatic promotion decision. A negative or inconclusive
paid result retains the simpler current policy. A proposed default change needs
separate review of the predeclared primary objective, complete independent final
validation, false alarms, retention, all costs and uncertainty. These controller
controls do not satisfy that empirical success condition.

Native retained-byte accounting includes snapshots, proposal JSON, actual-billing
receipts and final evaluation JSON. The native final adapter conservatively
preflights bounded output streams plus receipt overhead before dispatch, and
persists invoice digests alongside the evaluator evidence. Generic study reports
also charge their retained cost-receipt bytes against the artifact cap.
