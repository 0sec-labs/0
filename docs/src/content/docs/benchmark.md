---
title: Benchmark
description: Public security benchmark results, test conditions, and reproduction commands.
---

Published vulnerability disclosures are listed at [0.security](https://0.security). The CTF results below measure performance on smaller, controlled challenges. Compare scores using the same benchmark fork, model, turn cap, and retry protocol.

<span id="where-0sec-stands-honest-condition-specific"></span>
## Results

| Benchmark | Score | Conditions & caveats |
|-----------|-------|----------------------|
| [XBOW](https://github.com/xbow-engineering/validation-benchmarks) web CTFs | **93 / 95 = 97.9%** historical union | Historical gpt-5.4 challenge-level union across retained results (2026-05-06). Not a qualified black-box or single-shot rate; attempt/configuration receipts require reconstruction. |
| [Cybench](https://github.com/andyzorigin/cybench) | **36 / 40 = 90.0%** | First full-suite run, reported Azure gpt-5.4 configuration with up to 3 retries; not a one-attempt-per-challenge result. BoxPwnr's 40/40 is best-of-N across ~10 configs — not directly comparable. |
| npm audit (81 packages) | **F1 = 0.973** | `none` profile, 100% TPR, FPR 0.11. Self-published ground-truth set; see the [ablation log](/research/2026-04-11-ablation/). |
| AI/LLM suite (10 challenges) | 10 / 10 | Self-authored regression suite, not an independent benchmark. |
| [AutoPenBench](https://github.com/lucagioacchini/auto-pen-bench) / [HarmBench](https://www.harmbench.org/) | Not scored yet | Harness built; no published score. |

The historical XBOW per-model consolidator counts a challenge as solved if any
retained result for that model reports a solve. It does not partition that count
by black-box/white-box mode or configuration. The denominator is distinct
challenge IDs with a retained result, not independent attempts. Retention and
lookback selection affect both per-model and wider aggregates. These figures do
not establish superiority over another agent. The historical runner could also attribute a multi-model winning result to that
winning model, and repeated attempts could collapse into one `flagFound` value.
No corrected single-shot or black-box score is published here pending qualified
attempt-level reconstruction.
[Methodology](/methodology/) explains the distinction.

Qualification correction (2026-09-18): this interpretation follows the historical
`trackModelResult` aggregation in `packages/benchmark/src/scripts/consolidate-xbow.ts`
and retry/repeat handling in `packages/benchmark/src/xbow-runner.ts`. It corrects
the earlier single-shot/black-box wording; it does not report a new benchmark run.

## Running the canonical harness

`0sec bench run` is the single benchmark orchestrator. Integrations own only suite-specific target lifecycle and official grading; every run still produces the same manifest, attempt receipts, scorecard, tournament, and evidence contract.

```bash
# Core web/source-audit corpus.
0sec bench run --integration core --variants variants.json

# XBOW: Docker lifecycle + fresh per-attempt flag, scored by the shared oracle.
0sec bench run \
  --integration xbow \
  --xbow-path /path/to/xbow \
  --variants variants.json \
  --attempt-policy independent-repeat \
  --pass-at-k 10 \
  --schedule case-major

# CyberGym: official differential oracle, strict one graded submit per task.
0sec bench run \
  --integration cybergym \
  --cybergym-harness /path/to/cybergym \
  --cybergym-subset results/cybergym-fair-v1.subset.txt \
  --variants variants.json
```

`--attempt-policy pass-at-k` is the default and stops a case after proof. `independent-repeat` retains every scheduled fresh attempt for a per-attempt rate. `case-major` interleaves variants by task while keeping Docker and CyberGym execution serial.

Cybench, npm audit, AutoPenBench, and HarmBench retain their specialized suite commands until they are migrated through the same integration contract.

## Related

- **[0.security](https://0.security)**
- [Methodology](/methodology/) — per-attempt rate, Wilson CI, single-model caveats
- [XBOW Analysis](/research/xbow-analysis/) — how the XBOW score is built, and its limits
- [Competitive Landscape](/research/competitive-landscape/) — where other agents sit, briefly