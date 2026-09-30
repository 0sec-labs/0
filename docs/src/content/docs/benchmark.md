---
title: Benchmark
description: Public security benchmark results, test conditions, and reproduction commands.
---

Published vulnerability disclosures are listed at [0](https://0.security). The CTF results below measure performance on smaller, controlled challenges. Compare scores using the same benchmark fork, model, turn cap, and retry protocol.

<span id="where-0-stands-honest-condition-specific"></span>
## Results

These are **dated repository snapshots**, not a live leaderboard. The committed
`packages/benchmark/results/benchmark-ledger.json` was generated on 2026-05-07
and labels the XBOW/Cybench snapshot 2026-05-06. No new measurements are implied
by this documentation refresh.

| Benchmark | Score | Conditions & caveats |
|-----------|-------|----------------------|
| [XBOW](https://github.com/xbow-engineering/validation-benchmarks) web CTFs | **93 / 95 = 97.9%** | Recorded gpt-5.4 cohort, as of 2026-05-06. The consolidator counts a challenge solved if any retained result for that model found a flag; this is not established pass@1 or a black-box-only cohort. Recorded estimates: ~$0.48/result, **$5.20/solved challenge**. |
| [Cybench](https://github.com/andyzorigin/cybench) | **36 / 40 = 90.0%** | First recorded full-suite run, 2026-05-06, Azure gpt-5.4 with 3 retries. A retry-enabled single configuration is not a one-attempt success rate. |
| npm audit (81 packages) | **F1 = 0.973** | `none` profile, 100% TPR, FPR 0.11. Self-published ground-truth set; see the [ablation log](/research/2026-04-11-ablation/). |
| AI/LLM suite (10 challenges) | 10 / 10 | Self-authored regression suite, not an independent benchmark. |
| [AutoPenBench](https://github.com/lucagioacchini/auto-pen-bench) / [HarmBench](https://www.harmbench.org/) | Not scored yet | Harness built; no published score. |

The wider XBOW retained-artifact union in that snapshot is **103/104**, including
**102/104 white-box** and **81/104 black-box**; the recorded unresolved union
case is `XBEN-030-24`. These sets are not additive. Artifact expiration changes
what a later consolidation can recover, not the date or meaning of this snapshot.
The model grouping in `packages/benchmark/src/scripts/consolidate-xbow.ts`
does not separate white-box from black-box or enforce one attempt/configuration
per challenge. Preserve raw receipts before making those stronger claims.
[Methodology](/methodology/) explains the reporting protocols and cost caveats.

## Running the canonical harness

`0 bench run` is the canonical generic benchmark orchestrator. Integrations own
suite-specific target lifecycle and grading; the orchestrator shares manifests,
attempt receipts, scorecards, tournaments, and optional sealed evidence output.

```bash
# Core web/source-audit corpus.
0 bench run --integration core --variants variants.json

# XBOW: Docker lifecycle + fresh per-attempt flag, scored by the shared oracle.
0 bench run \
  --integration xbow \
  --xbow-path /path/to/xbow \
  --variants variants.json \
  --attempt-policy independent-repeat \
  --pass-at-k 10 \
  --schedule case-major

# CyberGym: official differential oracle, strict one graded submit per task.
0 bench run \
  --integration cybergym \
  --cybergym-harness /path/to/cybergym \
  --cybergym-subset results/cybergym-fair-v1.subset.txt \
  --variants variants.json
```

Configure model credentials first; these runs execute tools and can incur model
charges. XBOW requires Docker and a local benchmark checkout. CyberGym also
requires its external harness, task corpus, server and verifier configuration.
Use disposable, authorized benchmark infrastructure, not production targets.

`variants.json` is a nonempty JSON array, for example:

```json
[{"id":"baseline","runtime":"api","model":"YOUR_MODEL_ID","depth":"deep"}]
```

Alternatively omit `--variants` and use `--model`, `--runtime`, and `--depth`
for one implicit variant. `--variants` takes precedence over those shorthand
options. Pin and retain the model, harness revision, benchmark checkout revision,
feature settings, and target mode for each comparison.

Add `--tournament-output ./evidence/run-001.json` to retain create-once
`{manifest,tournament}` evidence, `--ledger ./evidence/ledger.json` to choose the
local tournament ledger, and `--format json` for machine-readable stdout.
This local ledger is distinct from the committed historical score ledger above.
`--max-turns` defaults to 40; `--cost-ceiling` is per attempt, not a total
tournament cap. Fresh independent repeats multiply execution and model costs.

`--attempt-policy pass-at-k` is the default and stops a case after proof. `independent-repeat` retains every scheduled fresh attempt for a per-attempt rate. `case-major` interleaves variants by task while keeping Docker and CyberGym execution serial.

Cybench, npm audit, AutoPenBench, and HarmBench retain their specialized suite commands until they are migrated through the same integration contract.

## Related

- **[0](https://0.security)**
- [Methodology](/methodology/) — per-attempt rate, Wilson CI, single-model caveats
- [XBOW Analysis](/research/xbow-analysis/) — how the XBOW score is built, and its limits
- [Competitive Landscape](/research/competitive-landscape/) — where other agents sit, briefly