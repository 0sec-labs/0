# Learning comparison: October 1, 2026

**The live model comparison found no improvement on this small test.** Both versions found both vulnerabilities and avoided both safe controls. Remembered context added tokens. This result is a reason to measure learning before enabling it broadly, not a claim that learning improves security results.

| Across two repeated reviews | No remembered note | Remembered note |
| --- | ---: | ---: |
| Confirmed vulnerabilities per review | 2 / 2 | 2 / 2 |
| False-positive candidates | 0 | 0 |
| Recall change | — | 0 percentage points |
| Input tokens | 556 | 728 |
| Output tokens | 131 | 169 |

The separate note-generation call used 74 input and 78 output tokens. Token counts come from the provider; no dollar cost was inferred for subscription inference. These repeats check stability on the same four cases. They are not four independent vulnerability samples and do not support a statistical improvement claim.

## What ran

The harness made five real, tool-free calls to `gpt-5.6-sol` through the engine's `chatgpt-codex` runtime: one development-note call and four reviews. The first attempted model, `gpt-6.1-sol`, was rejected by this account. The deployed model catalog was checked before selecting `gpt-5.6-sol`.

A separate parameterized database example produced a short security lesson. The harness saved that answer through the actual `HuntMemoryStore.rememberCodebase` path, bound it to the development file's hash, and recalled it through `recallCodebase`. Both review versions received the same four source functions. Only the learning version received that recalled note. Answers were parsed as candidate IDs and classes; model-supplied labels or verification flags were ignored.

The heldout review functions ran inside a temporary, loopback-only HTTP fixture. The SQL examples executed actual SQLite queries. The path examples attempted actual file reads from an owned temporary directory. Existing engine SQL and traversal oracles confirmed the vulnerable implementations and rejected the parameterized query and directory-bound download controls. The traversal sentinel resembled a passwd record but was a fixture file; the harness refused access outside its temporary root. No production system or external target was tested.

Both review versions used one call per repetition, a 45-second call timeout, no tools, the same response instructions and fixed validation probes. Review order was counterbalanced: baseline then learning, then learning then baseline. Input sizes differed because the learning version received context; the observed usage is included above. The OAuth backend does not accept a hard output-token ceiling, so this is a matched call/time-budget experiment, not an exact token-budget experiment.

## Reproduce

Build the engine first, then run:

```sh
pnpm --filter '@0/core...' build
node --test packages/benchmark/scripts/learning-paired.test.mjs
node packages/benchmark/scripts/learning-paired.mjs --output /tmp/learning-validators.json
node packages/benchmark/scripts/learning-paired.mjs --live --model gpt-5.6-sol --provider chatgpt-codex --output /tmp/learning-paired.json
```

The final command uses the selected provider account and makes at most five model calls. Choose a model deployed on that account. The validator-only command makes no model calls. Temporary fixture and memory directories are deleted after each run. Raw answers, source digest, validator evidence, usage and per-review scores are in [the result JSON](./learning-paired-2026-10-01.json).

## What this does not establish

This is a four-case source-review comparison with local runtime confirmation. It does not exercise the full autonomous scan loop, automatic workflow proposals, learning-page promotion, live SmolVM execution, unseen-project transfer or model weight updates. The model did not generate exploits; a frozen host-owned probe set supplied runtime confirmation. The two positive cases are simple and both arms reached the ceiling. No claim about realistic task performance follows from that.

The next useful measurement is a larger, preregistered corpus with more difficult unseen cases, paired model runs, frozen source and validator identities, equal spend ceilings and capability-retention checks. The repository's existing XBOW A/B runner could support part of this, but Docker was unavailable on this machine during this run. Do not enable automatic promotion or advertise performance lift on the basis of this result.
