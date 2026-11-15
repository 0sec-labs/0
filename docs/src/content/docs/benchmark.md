---
title: Benchmarks
description: Dated benchmark results, the conditions behind them and the commands to reproduce a run.
---

Run a benchmark with the shared orchestrator:

```bash
0 improve bench run --integration core --variants variants.json
```

`variants.json` is a nonempty JSON array. Or skip it and use `--model`, `--runtime` and `--depth` for one variant. `--variants` wins when both are given.

```json
[{"id":"baseline","runtime":"api","model":"YOUR_MODEL_ID","depth":"deep"}]
```

Configure model credentials first. These runs execute tools and spend model credits. Use disposable, authorized infrastructure, not production targets.

## Results

These are dated snapshots, not a live leaderboard. The ledger `packages/bench/results/benchmark-ledger.json` was generated on 2026-05-07 and labels the XBOW and Cybench snapshot 2026-05-06.

| Benchmark | Score | Conditions |
| --- | --- | --- |
| [XBOW](https://github.com/xbow-engineering/validation-benchmarks) web CTFs | 93 / 95 (97.9%) | gpt-5.4 cohort. A challenge counts as solved if any retained result found a flag. Not pass@1 and not black-box only. About $0.48 per result, $5.20 per solved challenge. |
| [Cybench](https://github.com/andyzorigin/cybench) | 36 / 40 (90.0%) | First full-suite run, Azure gpt-5.4, up to 3 retries. Not a one-attempt rate. |
| npm audit (81 packages) | F1 0.973 | `none` profile, TPR 100%, FPR 0.11. Self-published ground truth. See the [ablation log](/research/2026-04-11-ablation/). |
| AI/LLM suite (10 challenges) | 10 / 10 | Self-authored regression suite, not an independent benchmark. |
| [AutoPenBench](https://github.com/lucagioacchini/auto-pen-bench), [HarmBench](https://www.harmbench.org/) | Not scored | Harness built, no published score. |

The wider XBOW retained-artifact union in that snapshot is 103 / 104: 102 / 104 white-box and 81 / 104 black-box. The unresolved case is `XBEN-030-24`. These sets are not additive. The grouping in `packages/bench/src/scripts/consolidate-xbow.ts` is by model. It does not separate white-box from black-box or enforce one attempt per challenge.

Published vulnerability disclosures are at [0.security](https://0.security). The CTF scores above measure smaller, controlled challenges. Compare scores only under the same benchmark fork, model, turn cap and retry protocol. Where the XBOW score comes from: [XBOW analysis](/research/xbow-analysis/).

## Integrations

Each integration owns its target lifecycle and grading. The orchestrator shares manifests, attempt receipts, scorecards and tournaments.

```bash
# XBOW: Docker lifecycle, fresh flag per attempt, shared oracle.
0 improve bench run \
  --integration xbow \
  --xbow-path /path/to/xbow \
  --variants variants.json \
  --attempt-policy independent-repeat \
  --pass-at-k 10 \
  --schedule case-major

# CyberGym: official differential oracle, one graded submit per task.
0 improve bench run \
  --integration cybergym \
  --cybergym-harness /path/to/cybergym \
  --cybergym-subset results/cybergym-fair-v1.subset.txt \
  --variants variants.json
```

XBOW needs Docker and a local benchmark checkout. CyberGym also needs its harness, task corpus, server and verifier setup. Cybench, npm audit, AutoPenBench and HarmBench keep their own suite commands.

Options:

- `--tournament-output <path>` keeps create-once `{manifest,tournament}` evidence.
- `--ledger <path>` sets the local tournament ledger. It is separate from the committed score ledger above.
- `--format json` prints machine-readable output.
- `--max-turns` defaults to 40. `--cost-ceiling <usd>` applies per attempt, not to the whole run. Independent repeats multiply cost.
- `--attempt-policy pass-at-k` (default) stops a case after proof. `independent-repeat` keeps every scheduled attempt for a per-attempt rate.
- `--schedule case-major` interleaves variants by task. Docker and CyberGym execution stay serial.

To gate a change on regressions, see [Self-improvement](/self-improvement/#benchmark-variants).

## Method

A score depends on the fork, model, turn cap, feature settings, retry protocol and aggregation. Three ways to report the same raw data differ a lot. Say one challenge runs 10 times and solves once:

1. **Single-shot.** Run once, report pass or fail. Results vary between runs.
2. **Best-of-N.** Solved if any attempt succeeds, so 1 of 10 and 10 of 10 both count. The published XBOW protocol allows this.
3. **Per-attempt rate with a Wilson interval.** 1 of 10 is 10%, with a 95% interval of about 0.018 to 0.404. 0 uses this method internally.

On 2026-04-06 one configuration solved XBEN-061 in eight turns, then failed a repeat the same afternoon. The per-attempt rate was later estimated at 20 to 40%. One solve is an anecdote.

At N=10 near rates of 0 or 1, the normal-approximation (Wald) interval fails. It collapses to `[0, 0]` at k=0 and can leave `[0, 1]`. The [Wilson score interval](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval) fixes both. `--repeat N` writes it as `successRateCI95`.

```text
p      = passes / attempts
z      = 1.96
center = (p + z^2 / (2n)) / (1 + z^2 / n)
margin = z * sqrt(p(1-p)/n + z^2 / (4n^2)) / (1 + z^2 / n)
CI95   = [center - margin, center + margin]
```

Aggregates across several models, solvers or prompts count a challenge as solved if any configuration succeeds, and sum their costs. The 93 / 95 cohort is that kind of aggregate, not a single-config, single-shot rate.

### Cost per flag

Report dollars per flag next to solve rate, with an explicit denominator. The gpt-5.4 ledger records $5.20 per solved challenge and $0.478 per recorded result. These are not the price of a new scan. In `consolidate-xbow.ts`, repeat-mode rows contribute `meanCostUsd`, not the sum of all attempts, and rows without a positive cost are left out of the per-run denominator. For a new aggregate, sum every attempt from its receipts, including failures and all configurations, and disclose missing prices. See [Cost per flag](/research/2026-05-08-cost-per-flag/).

### What to publish with a number

- Fork (upstream, `0ca` patched or `KeygraphHQ`) at a git sha.
- Exact model ID and provider.
- Turn cap per attempt. It is not the number of tool calls.
- The `ZERO_FEATURE_*` flags in effect.
- Retry protocol (best-of-K or repeat-N) and the value.
- Per-attempt success rate and its 95% Wilson interval.
- Cost ceiling in effect.

## Specialized XBOW runner

For new runs use `0 improve bench run --integration xbow`. The older runner remains for repeat statistics on a slice:

```bash
pnpm --filter @0/bench xbow \
  --agentic \
  --only XBEN-010,XBEN-051,XBEN-061,XBEN-066 \
  --repeat 10 \
  --repeat-cost-ceiling-usd 5.00 \
  --fresh --json
```

It writes `xbow-latest.json`. With repeats it adds `repeatProtocol`, `successRate` and `successRateCI95` per challenge. `passed` and `flagFound` mean any attempt succeeded. Use `passes / attempts` for the per-attempt rate, and check `costCeilingHit` before assuming N attempts ran.

## Next

- [XBOW analysis](/research/xbow-analysis/)
- [Triage and validation](/triage/)
- [Research index](/research/)
