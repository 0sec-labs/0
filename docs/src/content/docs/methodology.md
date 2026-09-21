---
title: Benchmark methodology
description: XBOW attempt rates, confidence intervals, configuration disclosure, and cost measurement.
---

XBOW scores depend on the fork, model, turn cap, feature settings, retry protocol, and aggregation method. Published vulnerability disclosures are listed separately at [0](https://0.security).

<span id="a-single-solve-is-an-anecdote"></span>
## Repeated attempts

On 2026-04-06, one configuration solved XBEN-061 in eight turns and failed a repeat run that afternoon. Its per-attempt success rate was later estimated at 20–40%. Use `--repeat N` to evaluate a candidate default across repeated attempts.

## Three methodologies, one raw dataset

Run a challenge 10 times under one configuration and it solves on run #3 only. Each methodology reports that dataset differently:

1. **Single-shot** — run once and report pass/fail. Results vary between runs.
2. **Best-of-N aggregate** — count the challenge as solved if any attempt succeeds. Both 1/10 and 10/10 count as solved. The published XBOW protocol permits this method.
3. **Per-attempt rate with Wilson CI** — report `passes / N` with a 95% Wilson score interval. One success in ten attempts gives 10%, with CI roughly `[0.018, 0.404]`. The interval shows the uncertainty at this sample size. 0 uses this method internally.

<span id="why-wilson-not-wald"></span>
### Interval choice

At N=10 near rates of 0 or 1 — exactly the XBOW regime — the normal-approximation (Wald) interval is wrong: it collapses to `[0, 0]` when k=0 and can extend outside `[0, 1]`. The [Wilson score interval][wilson] fixes both, and it's what `--repeat N` emits in `successRateCI95`.

[wilson]: https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval

```
p      = passes / attempts
z      = 1.96                     # 95% CI
center = (p + z²/(2n)) / (1 + z²/n)
margin = (z * sqrt(p(1-p)/n + z²/(4n²))) / (1 + z²/n)
CI95   = [center - margin, center + margin]
```

## Single-config vs. aggregate-of-configs

For runs across multiple models, solvers, or prompts:

- **Single-config** reports one setup, once per challenge.
- **Aggregate** counts a challenge as solved if any configuration succeeds and sums their costs.

Compare results using the same aggregation method. The committed gpt-5.4
**93/95 = 97.9%** cohort is a dated retained-results aggregation, not proof of
a single-config, single-shot rate. The consolidator groups by model ID, counts
any successful retained result for a challenge, and does not split that model
group by black-box/white-box mode. See [Benchmark](/benchmark/) for the snapshot.

<span id="flag-is-a-first-class-axis"></span>
## Cost per flag

Report `$/flag` alongside solve rate, with an explicit denominator. The historical
gpt-5.4 ledger records $5.20 per solved challenge and $0.478 per recorded result.
These are not the price or expected success cost of a new scan. In
`consolidate-xbow.ts`, repeat-mode rows contribute `meanCostUsd`, not the sum of
all repeated attempts; rows without a positive cost do not enter the cost-per-run
denominator. For a new aggregate, sum every attempt's cost from its receipts,
including failures and all configurations, and disclose missing prices.

<span id="what-0sec-publishes-with-every-number"></span>
## What to publish with every number

Retain the following alongside any new XBOW claim:

- **Fork** (upstream / `0ca` patched / `KeygraphHQ`) at a specific git sha
- **Model** — exact model ID and provider
- **Turn cap** — configured agent-turn limit per attempt (not necessarily the number of tool calls)
- **Feature stack** — the `0SEC_FEATURE_*` flags in effect
- **Retry protocol** — best-of-K vs. repeat-N, and the value
- **Per-attempt success rate** and its **95% Wilson CI**
- **Cost ceiling** — the `--repeat-cost-ceiling-usd` in effect

The specialized XBOW runner emits `repeatProtocol` and per-cell aggregation fields
when `--repeat > 1`; those fields alone do not encode all of the provenance above.
Keep configuration and checkout revisions with the result. The repository's
[benchmark ledger](https://github.com/0sec-labs/0/blob/main/packages/benchmark/results/benchmark-ledger.json)
is a dated summary separating retained artifact-backed and historical publication
lines, not an automatically current score.


## Run the harness yourself

For new canonical runs, use `0 bench run --integration xbow --xbow-path ...`
with `--attempt-policy independent-repeat --pass-at-k N`; see
[Benchmark](/benchmark/#running-the-canonical-harness) for configuration and
evidence capture. Its options and result schema differ from the specialized
runner below.

The following specialized-runner example repeats a **historical selected slice**,
not the current unresolved set:

```sh
pnpm --filter @0sec/benchmark xbow \
  --agentic \
  --only XBEN-010,XBEN-051,XBEN-061,XBEN-066,XBEN-080,XBEN-084,XBEN-099,XBEN-104 \
  --repeat 10 \
  --repeat-cost-ceiling-usd 5.00 \
  --fresh --json
```

The historical `XBOW Benchmark` workflow is not present in this checkout.
Run the package command directly. It writes `xbow-latest.json` with `repeatProtocol`,
`successRate`, and `successRateCI95` per challenge when repeats are enabled.
`passed`/`flagFound` mean any attempt succeeded; use `passes / attempts` for
the per-attempt rate, and inspect `costCeilingHit` before assuming N attempts ran.

## Related

- **[0](https://0.security)**
- [Benchmark](/benchmark/) — the compact score view and caveats
- [XBOW Analysis](/research/xbow-analysis/) — how the XBOW score is built and its limits
- [Competitive Landscape](/research/competitive-landscape/) — where other agents sit