---
title: XBOW Analysis
description: Where 0's XBOW score comes from, its caveats, and what the benchmark does and doesn't tell you.
---

XBOW is a web-CTF substrate, not a qualification for arbitrary production targets.
Public [research and disclosure records](https://0.security/research/) document
separate investigations with their own evidence and limitations.

<span id="how-0sec-scores-on-xbow-and-the-caveats"></span>
## How 0 scores on XBOW, and the caveats

**The 2026-05-06 ledger snapshot records 93 / 95 = 97.9% for gpt-5.4.**
It records ~$0.48 per result and $5.20 per solved challenge. These are historical
estimates, not current scan pricing or a measured one-attempt success probability.

Caveats:

- **One model ID does not mean one attempt or one configuration.**
  `packages/benchmark/src/scripts/consolidate-xbow.ts` counts a challenge solved
  if any retained result for that model has `flagFound`. Its per-model grouping
  does not separate white-box and black-box modes. The ledger's original
  single-shot/black-box interpretation is not established by that aggregation.
- **Retained-artifact aggregate is rotation-volatile.** The committed snapshot
  is dated; a later artifact collection can contain a different evidence window.
  Preserve receipts and compare explicit attempt/mode cohorts instead of treating
  the checked-in ledger as a live score.
- **CTF ≠ real repo.** XBOW challenges are small, single-vuln web apps with a
  planted flag. Solving them says nothing about
  finding a novel bug in a million-line kernel tree.
- **Cross-project scores aren't matched-conditions.** Fork, turn cap, and retry
  protocol all move the number by several points. See [Methodology](/methodology/).

The retained-artifact vs. historical-publication distinction and the
challenge-set mismatch live on the [Benchmark](/benchmark/) page and in the
benchmark ledger.

## Where the remaining gaps are

The snapshot's any-model, any-mode unresolved set contains only `XBEN-030-24`.
The following are broader historical failure themes, not that unresolved list:

| Class | Why it's still hard |
|-------|---------------------|
| Hard XSS | Browser-oracle usage still lags the best specialized agents. |
| Blind SSTI / deep exploit chains | Evidence is weak early, so budget gets spent proving exploitability. |
| Complex stateful auth workflows | Multi-step auth chains still degrade reliability. |
| Long-horizon exploit planning | Remaining tasks punish retries that don't materially pivot. |

## Design hypotheses and implemented mechanisms

- **Shell-first.** The [small early comparison](/research/shell-first/) motivated
  a compact shell interface; it does not establish universal superiority over
  structured tools.
- **Budget-aware execution.** The native loop implements reflection and budget
  warnings, loop detection, and feature-gated compaction. Compaction preserves
  context capacity; it does not add turns to the configured limit.
- **Explicit budgets.** Use the harness's `--max-turns` for comparable runs
  (canonical bench default: 40). A turn can contain multiple tool calls.
- **Concurrent subagents.** `spawn_agents` lets the lead agent fan
  out focused children concurrently (bounded fan-out, default concurrency 4) and a
  child can coordinate with its parent.
- **White-box mode.** `--repo <path>` gives the agent source alongside `bash`, which
  lifts the ceiling on challenges with no web-facing vector (e.g. credentials
  hardcoded in source). CI runs black-box and white-box independently.

## Framework vs. model

The framework provides scope controls, context management, subagent fan-out,
retry/handoff, and workflow-specific verification. This benchmark does not
isolate which mechanism caused a gain, rank models for every task, or demonstrate
automatic optimal model selection. See [Research Workflows](/research-workflows/)
for explicit model diversity and execution boundaries.

## Other benchmarks in scope

| Benchmark | Domain | Scale | 0 relevance |
|-----------|--------|-------|----------------|
| [Cybench](https://github.com/andyzorigin/cybench) | Broad CTF (web/crypto/pwn/rev) | 40 challenges | 2026-05-06 snapshot: 36/40 = 90.0%, one configuration with retries |
| [AutoPenBench](https://github.com/lucagioacchini/auto-pen-bench) | Network / CVE pentesting | 33 Docker tasks | Harness built; shell-first maps to its `execute_bash` |
| [HarmBench](https://github.com/centerforaisafety/HarmBench) | LLM red-teaming | 510 behaviors | Lightweight `sendPrompt()` harness |
| npm audit (self-published) | Package auditing | 81 packages | F1 = 0.973; see [ablation log](/research/2026-04-11-ablation/) |

## Related

- **[0](https://0.security)**
- [Benchmark](/benchmark/)
- [Methodology](/methodology/)
- [Competitive Landscape](/research/competitive-landscape/)