---
title: Finding triage ML
description: "Design record for learned finding triage: shipped gates, the rule-based router, the trained classifier experiments and what is still planned."
---

> Status: April 2026 design record. Implementation and planning appear together, and each section says which it is. The shipped runtime is described on [Triage and validation](/triage/). Measured effects are on [False-positive reduction](/research/false-positive-reduction/). Tracking issues: [0#113](https://github.com/0sec-labs/0/issues/113) (routing), [0#67](https://github.com/0sec-labs/0/issues/67) (classifier).

## Problem

Verification re-tests candidate findings, and every re-test costs time and money. This record asks how features, classifiers and extra checks change recall, false positives and cost, and whether a router can pick the useful checks per finding.

## Approach

The design combines VulnBERT-style hybrid classification (handcrafted features plus a neural encoder) with structured LLM verification. VulnBERT predicts vulnerability-introducing Linux kernel commits. In its own ablation, handcrafted features alone reached 76.8% recall at 15.9% false positives, CodeBERT alone 84.3% and 4.2%, and the hybrid 92.2% and 1.2%. That is a kernel-commit result, not a measurement of 0.

| Layer | Status | Implementation |
| --- | --- | --- |
| Feature extraction (55 handcrafted features) | Shipped | `triage/feature-extractor.ts`, `extractFeatures(finding): number[]` |
| Holding-it-wrong filter | Shipped | `triage/holding-it-wrong.ts` |
| Reachability gate | Shipped, conservative | `triage/reachability.ts` |
| Per-class oracles | Shipped | `triage/oracles.ts`, `verifyOracleByCategory` |
| Multi-modal agreement with FoxGuard | Shipped, opt-in | `triage/multi-modal.ts` |
| Structured 4-step verification | Shipped | `triage/structured-verify.ts` |
| Self-consistency consensus | Shipped, opt-in | `runSelfConsistencyVerify`, `ZERO_FEATURE_CONSENSUS_VERIFY` |
| PoV gate | Shipped, opt-in | `triage/pov-gate.ts`, `ZERO_FEATURE_POV_GATE` |
| Triage memories | Shipped | `triage/memories.ts` |
| CodeBERT classifier | Planned | Fine-tune `microsoft/codebert-base` on finding text. |
| Cross-attention fusion | Planned | Fuse the feature vector with CodeBERT embeddings. |
| Adversarial debate | Planned, not implemented | No `triage/adversarial.ts` and no debate flag exist. The nearest shipped mechanism is the cross-family refuter (`stages/hunt-cross-family.ts`). |

The feature vector is regex and string work, with no model call or network call. It covers response signals (status, SQL errors, stack traces, reflected payloads, WAF signatures), request signals (payload shape, method, parameter count), metadata (severity, confidence, category class, CWE and CVE presence), description quality (reproduction steps, hedging language) and cross-field ratios (payload and category agreement, evidence completeness). It started at 45 features and now has 55, with 10 kernel-crash features added. The 45-feature figures below predate that change. The ~77% recall and 16% false-positive rate quoted for the original vector are historical, not current accuracy.

## Triage dataset

`triage-dataset-v1.jsonl` (969 rows, 884 true and 85 false positives) came from 21 ablation runs. `triage-dataset-v2.jsonl` has 1,514 rows. Ground truth comes from flag extraction on XBOW rows, package verdicts on npm-bench rows and blind-verify status on local scans. The schema and collector are described in [Triage dataset](/research/triage-dataset/).

The imbalance is a known problem. The v1 set is 91.2% true positives, far from where VulnBERT's focal-loss tuning was validated.

## Dynamic routing

### Why

The [2026-04-11 ablation](/research/2026-04-11-ablation/) found a different best static policy per slice. `no-triage` gave the best white-box flag count, the full stack was best on black-box, and `none` had the lowest npm false-positive rate. On the 14-challenge stubborn slice, reachability added three flags at $1.61 per flag, while EGATS lost one at $15.93 per flag. A router would choose layers per finding instead.

Design goals: select layers per finding while keeping operator feature controls, match or beat the best static profile on every slice, keep inference under a millisecond on CPU, expose the features behind each decision, and A/B test behind a default-off flag.

### Rule-based router v0 (shipped, default off)

`packages/engine/src/triage/router/` picks from 11 layers per finding. Enable it with `ZERO_FEATURE_DYNAMIC_TRIAGE=1`. It can never invoke a layer the operator disabled. The decision contract lets a later classifier replace it:

```ts
interface RouterModel {
  readonly id: string;
  predict(finding: Finding, features: RoutingFeatures): RoutingDecision;
}
interface RoutingDecision {
  layers_to_invoke: LayerId[];
  confidence: number;
  reasoning?: string;
  matchedRule?: string;
}
```

Rules are evaluated in this order and the first match wins:

1. High-confidence SQL injection (confidence at least 0.8, with a SQL error in the response). Uses the default static layer set with high routing confidence.
2. Strong false-positive match. A triage memory scores at least 0.85, with the same category and agent confidence below 0.6. Invokes no layers, so the finding is auto-rejected. The default router is built without a memory matcher, so this rule is inactive unless a caller supplies one. Coarse token overlap can reject a real finding, so measure before loosening these thresholds.
3. Ambiguous logic bug. Category in `missing-validation`, `security-misconfiguration`, `information-disclosure`, `cors`, `tool-misuse` or `output-manipulation`, with confidence between 0.3 and 0.55. Adds `structured_verify` and `pov_gate` to the free layer set.
4. Default. The static layer set, which is the same as the pipeline without a router.

Layer selection is not model-provider routing. Registry membership does not mean every layer runs on every workflow.

With the flag on, the scanner writes one JSONL record per finding to `~/.0/runs/<scan-id>/routing-trace.jsonl` and logs a `dynamic_triage_routing` event. A record holds the feature vector and names, the layers decided, the matched rule, router confidence and the per-layer verdicts. A live trace has no ground truth. Join outcomes offline.

### Learned classifier (experiment, not deployed)

A router model would predict, per layer, whether running it would change the final verdict and whether it is worth its cost, plus a true or false positive probability that can shortcut to auto-accept or auto-reject. Free layers (regex, grep, oracles) should always run. Layers with model cost (structured verify, consensus) should run only when likely to flip the verdict.

Candidates, in order: an XGBoost multi-label head on the feature vector (CPU, sub-millisecond, interpretable), a small head on fused features and CodeBERT embeddings (about 10 ms on CPU), and distillation from a larger model.

XGBoost was trained on `triage-dataset-v2.jsonl` (100 trees, depth 5, weighted for imbalance). The model is `packages/bench/results/triage-router-v1.json`.

| Evaluation | Result |
| --- | --- |
| 5-fold cross-validation | F1 0.944, precision 0.969, recall 0.920, AUC 0.886 |
| Leave out npm-bench | F1 0.664 (true-positive recall 50%) |
| Leave out xbow black-box | F1 0.859 (true-positive recall 78%, false-positive recall 33%) |
| Leave out xbow white-box | F1 0.900 (true-positive recall 93%, false-positive recall 12%) |

Cross-slice generalization is poor. Slice indicators improved npm-bench only to 0.705. Per-slice classifiers did far better within their slice: npm-bench F1 0.930, xbow white-box 0.914, xbow black-box 0.721 on only 115 rows. Feature importance differs by slice. npm-bench leans on description length, black-box on the response to request length ratio, and white-box on real exploit indicators such as path traversal and parameter count.

Decision: per-slice classifiers are the deployment target, because the scanner knows its mode and target type at start. Deployment options, fastest first: hand-coded thresholds from the learned splits (what `triage/learned-router.ts` contains, behind `ZERO_FEATURE_LEARNED_ROUTER`), a JS XGBoost loader, or ONNX. `learned-router.ts` is a hand-coded TP/FP scorer, not a generic tree loader and not a deployed learned layer selector.

Planning target for a trained router: 2,500 to 5,000 labeled findings with per-layer verdicts. The corpus has about 1,514 rows. Beating the rules still needs evaluation on every slice.

### Bars a router must clear

- XBOW white-box at limit 50: at least `no-triage` (44 of 50 flags), with the finding-count reduction of the full stack.
- XBOW black-box at limit 50: at least the full stack (19 of 25 at limit 25).
- npm-bench F1 on 81 packages: at least `none` (0.973, false-positive rate 0.11).
- Dollars per flag no worse than the best static profile on each slice.
- No category loses more than 5% recall against its per-slice baseline.

### Open questions

- How to balance a 91% true-positive dataset: undersample, or generate more false positives from benign packages.
- Whether the router should see the attack agent's reasoning. It might help, but it turns the router into a full model call.
- Whether to skip layers the agent already covered, such as oracles on a finding that already captured a flag.
- How to avoid overfitting to XBOW (104 challenges) and npm-bench (81 packages). It needs a held-out slice outside every training set.
- EGATS stays out of the router's action space until it is rewritten.

## Measured effects

Design targets in the original plan (recall near 97%, false-positive rate near 5%) were never measurements. The measured effect, from the 2026-04-11 ablation with gpt-5.4:

- XBOW white-box at limit 50: the full stack cut findings 63% (67 to 25) and scored 41 of 50 flags, against 43 for `none` and 44 for `no-triage`. Cost per flag was $0.53 against $0.33 for `none`.
- XBOW black-box at limit 25: 19 against 18 flags, 14 against 27 findings, and $0.53 against $0.76 per flag.
- npm-bench: true-positive rate 100% on every profile. `default` and the full stack matched at F1 0.956. False positives rose from 0.11 (`none`) to 0.19 (`default`) in batch 1, and batch-2 variance prevents clean attribution.

## References

| Paper | What 0 took |
| --- | --- |
| [FalseCrashReducer](https://arxiv.org/abs/2510.02185) | A validation agent must reproduce the crash. Motivated the PoV gate. |
| [All You Need Is A Fuzzing Brain](https://arxiv.org/abs/2509.07225) | Agents that fail to build a PoC in N turns are almost always on a false positive. Basis for `pov-gate.ts`. |
| [MAPTA](https://arxiv.org/abs/2508.20816) | Evidence-gated branching. Basis for EGATS and the no-speculation posture. |
| [Debate](https://arxiv.org/abs/2402.06782) | Adversarial verification. Reserved for the planned debate layer. |
| [IBM D2A](https://arxiv.org/abs/2102.07995) | Differential-analysis labels for static-analysis findings. Training corpus target. |
| [VulnBERT](https://pebblebed.com/blog/kernel-bugs) | Hybrid features plus encoder with cross-attention. Basis for the feature layer and planned fusion. |

Other: [D2A dataset](https://github.com/IBM/D2A), [VulBERTa](https://github.com/ICL-ml4csec/VulBERTa), [GitHub Security Lab taskflow-agent](https://github.com/GitHubSecurityLab/seclab-taskflow-agent) (an open-source LLM triage pipeline).

Related: [Triage dataset](/research/triage-dataset/), [2026-04-11 ablation](/research/2026-04-11-ablation/), [Triage and validation](/triage/).
