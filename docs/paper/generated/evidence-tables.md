# Generated publication evidence

Audit date: 2026-09-30. Unsubmitted. Offline, immutable inputs; no new measurements.

## Historical observations

| Cohort | Recorded outcome | Qualification |
| --- | --- | --- |
| XBOW retained May 4 union | 38 black-box / 53 white-box / 53 any-mode successes | Union over repeated runs; failed-attempt denominator unknown. |
| May 6 ledger headline | Suppressed | Different snapshot; model union is not black-box-only or single-shot. |
| Reasoning A/B control | 3/3 success; median estimated USD 0.231438 | One target; missing model/source identity; target parser errors. |
| Reasoning A/B treatment | 3/3 success; median estimated USD 0.191982 | Quality unchanged; not independently measured provider charges. |
| Reasoning A/B cost change | -17.05% | Preliminary one-target observation; no generalization inference. |
| CyberGym July 4 | 40/54 successes; 14 failures; 54 unique tasks | No matched evolution comparison; costs unknown. |

All recorded CyberGym failures and A/B target errors remain part of the evidence. April triage summaries in evaluation.md retain their regressions; complete raw run/cost records are missing, so efficacy is unqualified.

## Classifier label and leakage audit

| Measure | Value |
| --- | --- |
| rows | 1514 |
| positives | 1410 |
| negatives | 104 |
| duplicateTexts | 421 |
| groups | 520 |
| repeatedGroups | 346 |
| mixedLabelGroups | 11 |
| pooledAlwaysPositiveF1 | 0.9644322845 |
| recordedRowCvF1 | 0.9617489164 |

Label origins: {"flag_extraction":613,"package_verdict":901}. All labels are outcome-level weak supervision. The always-positive F1 above is pooled, not identical-fold CV. The stored row-CV metric is reported for audit only; no finding-precision, generalization or router-efficacy claim is made. No retraining/deployment occurred.

## Claim-to-artifact map

| Claim | Status | Inputs | Limits |
| --- | --- | --- | --- |
| Offline publication pipeline | implemented | publicationGenerator | Source presence is separate from empirical efficacy; no publication code is imported by ordinary scans. |
| Retained May 4 XBOW successes | historical observation | xbow, consolidator | Union across runs/modes; complete attempts and failures unavailable; no single-shot/generalization claim. |
| May 6 93/95 black-box/single-shot headline | unreconstructible; suppressed | ledger, consolidator, xbow | The model summary unions both modes; May 4 input is incompatible with the May 6 ledger. |
| Retained reasoning cost A/B | preliminary observation | ab | One target, three runs per arm, unchanged 3/3 success, parser errors and missing provenance; not a quality/generalization result. |
| CyberGym task campaign | historical observation | cybergym | Recorded failures retained; no matched evolution arm. |
| Router finding precision/generalization | not established; omitted | router, routerMeta, trainer | Weak supervision, duplicate/group leakage and class imbalance; CV efficacy not claimed. |
| Autonomous evolution improves unseen security outcomes | proposed; not measured | evolution | Synthetic correctness tests do not establish efficacy; separately budgeted qualification remains #120. |

Architecture/source presence, synthetic correctness and empirical efficacy are separate. Source input hashes establish the audited code bytes, not the execution identity of historical runs. Synthetic regression tests validate contracts; they supply no unseen-security efficacy estimate.

## Missing or incompatible evidence

- May 4 input versus May 6 ledger: incompatible cohorts.
- Complete failed-attempt denominator, source/evaluator revision and supplier charges are unknown.
- Per-model union exceeds black-box union: the model summary includes both modes, not a black-box subset.
- Outcome-level weak supervision does not establish individual-finding truth.
- Row-wise CV is not a group-held-out generalization result; efficacy claims omitted.
- One retained campaign; no matched self-evolution arm.
- Source revision and supplier charges are unknown.
- xbow: missing full failed-attempt denominator.
- xbow: missing source revision.
- xbow: missing evaluator revision.
- ledger: missing immutable raw May 6 cohort.
- ab: missing resolved provider/model identity.
- ab: missing source revision.
- ab: missing raw supplier charges.
- cybergym: missing source revision.
- cybergym: missing provider charges.
- cybergym: missing matched comparison arm.
- router: missing per-finding independent labels.
- router: missing group-held-out evaluation.
- routerMeta: missing immutable fitted model/fold receipt.
- routerMeta: missing group-held-out evaluation.

- The benchmark target emitted body-parser syntax errors in control-1 and treatment-1; both runs completed successfully. Treat cost and duration as valid recorded outcomes, but do not present these six runs as a clean reliability benchmark.
- The target and model are stochastic. Results are reported as medians and ranges must be re-measured on a larger, version-pinned suite before making product or public claims.

## Immutable inputs

| ID | Path | SHA-256 | Protocol | As of |
| --- | --- | --- | --- | --- |
| xbow | packages/benchmark/results/xbow-canonical.json | e35bab4723576890cac3d7fd6e904de54e1c6c0d2fa444160910d59e7d73ef09 | retained success union across CI runs and modes | 2026-05-04 |
| ledger | packages/benchmark/results/benchmark-ledger.json | d1203af5cc79050c4504bd7c1fb297e3ddd64bbd02a07929c872dad4005aa643 | historical ledger summary; incompatible snapshot | 2026-05-06 |
| ab | packages/benchmark/results/retained-reasoning-multiturn-ab-20260802.json | f3ff4748eaabc3423d939cee77755c578dc6444bfc536841d6b061e58141e956 | interleaved 3 control / 3 treatment runs on one target | 2026-08-02 |
| cybergym | packages/benchmark/results/cybergym-hardgate-full54-20260704.jsonl | b3ef2bc827ce5c27eaa97558e7458e0e90beebf326220e5f84dd11c11cbe2db6 | single retained task campaign; no evolution comparison | 2026-07-04 |
| router | packages/benchmark/results/triage-dataset-v2.jsonl | 9dec0a6fce39f015a368c5f58e5f922e1393929811120f40b0a428a4ff7677d5 | finding rows labelled by challenge/package outcome | unknown |
| routerMeta | packages/benchmark/results/triage-router-v2-meta.json | 29dedf736f6f39b3b6dcc4eba95b5e6de9ebf5aebaaff32a990d7ed008f9b104 | historical row-wise cross-validation summary | unknown |
| consolidator | packages/benchmark/src/scripts/consolidate-xbow.ts | 7208c641ac84a158cfb5e927ee56dad31a341d9fe47d3fc61f205af3bb1c33b0 | implementation source snapshot | unknown |
| trainer | packages/benchmark/scripts/train/train_triage_v2.py | 098f9ae9664a5b8d1556fa3d2c424b5e5de422e0d857aef59221478c0ed014cb | implementation source snapshot | unknown |
| evolution | packages/core/src/improvement/evaluation.ts | fdc410386b956d5c6ccf784cb2a5cb0d3c1618da643f84b6f7878486f7d9afc0 | implementation source snapshot; not efficacy evidence | unknown |
| publicationGenerator | packages/benchmark/scripts/paper-evidence.mjs | a1ea5587c0760b58f76ffe266a0022869bc42faceddb939a46ca931b57e704ce | offline publication source; no historical execution identity implied | 2026-09-30 |
