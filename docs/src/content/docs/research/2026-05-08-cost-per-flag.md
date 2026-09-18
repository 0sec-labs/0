---
title: "2026-05-08 Cost per Flag: A Missing Axis in Autonomous-Pentest Reporting"
description: "Historical XBOW cost accounting: $0.48 per recorded run and $5.20 per verified flag in the gpt-5.4 cohort."
---

> **Historical research log (2026-05-08).** Dated figures reflect the benchmark ledger at the time; the 93/95 figure is a historical challenge union, not a qualified black-box or single-shot rate. See [Benchmarks](/benchmark/) for the qualification limits.

*Published 2026-05-08. Numbers come from the canonical [benchmark ledger](https://github.com/0sec-labs/0sec/blob/main/packages/benchmark/results/benchmark-ledger.json) and are recomputed on every CI consolidation run.*

<span id="lead"></span>
## Measurement

This record preserves historical XBOW solve counts and estimated token costs.
The consolidation did not qualify a common mode/configuration/attempt cohort;
the figures must not be treated as one controlled run.

## The cost-axis design space

Four candidate cost denominators:

- **`$/run`:** spend divided by attempts. Disclose retry policy and turn budget.
- **`$/finding`:** spend divided by reported findings; false positives affect
  the denominator.
- **`$/flag`:** spend divided by verified benchmark solves.
- **Sweep total:** disclose challenge count and all attempts, including failed
  runs. `$/flag × flags-found` recovers the total.

Report the number of configurations and attempts in best-of-N comparisons.

## 0sec's number

The recorded Azure gpt-5.4 cohort used up to three retries per challenge and a $5.00 ceiling:

> **Historical gpt-5.4 challenge union: 93 / 95 = 97.9% — ~$0.48 / positive-cost result, $5.20 / union-solved challenge.**
>
> Recorded positive cost across retained results covering 95 distinct challenges: **$483.75**. Missing/zero-cost records are excluded from the average; complete spend is not established.

Historical excerpt (the original "stable cohort" label is unqualified), from the [`packages/benchmark/results/benchmark-ledger.json`](https://github.com/0sec-labs/0sec/blob/main/packages/benchmark/results/benchmark-ledger.json), specifically the `xbow.retainedArtifactBacked.perModel` section:

```json
"gpt-5.4": {
  "label": "Model-specific stable cohort (load-bearing claim)",
  "solved": 93,
  "attempted": 95,
  "ratePct": 97.9,
  "totalCostUsd": 483.75,
  "costPerRunUsd": 0.478,
  "costPerFlagUsd": 5.2
}
```

Every scan run logs token counts (input, output, cached-input separately) into its result JSON. `packages/core/src/agent/cost.ts` applies provider-specific per-1M-token rates from a hard-coded pricing table (gpt-5.4 input $2.50/1M, output $10.00/1M; with comparable rows for Anthropic, Google, DeepSeek, Meta, Mistral, and Z.AI models). `packages/benchmark/src/scripts/consolidate-xbow.ts` walks every retained `xbow-results-*` GitHub Actions artifact, groups results by model, and aggregates positive recorded cost. It divides by positive-cost result count for `$/run` and distinct union-solved challenges for `$/flag`. It does not partition the per-model tally by mode or configuration. Repeated-run `meanCostUsd` can also enter as one cost without multiplying by attempt count. These figures therefore establish neither complete total spend nor single-shot cost.

The consolidate script's per-model summary line:

```
gpt-5.4: 93/95 (97.9%) — $0.48/run, $5.20/flag
```

Recomputed on every CI sweep that lands artifacts in the 200-run lookback window.

## What "cost-aware" means in practice

The recorded $483.75 is historical retained cost, not a complete budget estimate
for a new 95-challenge run. Comparable experiments, repository scans and
disclosure workflows need complete attempt-level cost measurements.

<span id="why-most-agents-do-not-publish"></span>
## Reporting gaps

Comparisons require the model, provider rates, cached-input treatment, retry
count, and configuration count. Include failed attempts in total spend and
identify contractual or self-hosted pricing assumptions.

<span id="what-0sec-does-that-makes-this-work"></span>
## Cost records

- Per-token cost tracking lives in `packages/core/src/agent/cost.ts`. Every model has an input/output/cached-input rate. Unknown models fall back to a conservative default and emit a log line.
- Per-model breakdown is computed by `packages/benchmark/src/scripts/consolidate-xbow.ts`, which walks the retained CI artifacts and groups results by the `model` field in each run.
- [issue #231](https://github.com/0sec-labs/0sec/issues/231) tracks adding `cost_usd`, `cost_breakdown` (by provider/model), and `cost_per_flag` to the `scan_completed` event payload.

## What is still missing

The historical $5.20/flag divides recorded cost by the gpt-5.4 solved union, with incomplete cost coverage. Equivalent cross-model
sweeps and real-repository costs were unmeasured. Cost per rejected finding
(`$/wrong-flag`) was also unpublished.

<span id="closer"></span>
## Reporting requirements

Publish solve counts, total spend, attempt counts, pricing assumptions, and
evaluation conditions together.

## Related

- [Methodology](/methodology/)
- [Benchmark](/benchmark/)
- [Competitive Landscape](/research/competitive-landscape)