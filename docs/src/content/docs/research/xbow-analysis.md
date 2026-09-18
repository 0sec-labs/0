---
title: XBOW Analysis
description: Where 0sec's XBOW score comes from, its caveats, and what the benchmark does and doesn't tell you.
---

XBOW is a web-CTF substrate. A benchmark score is not the product — real disclosed CVEs at **[0.security](https://0.security)** are the proof. This page explains how 0sec's XBOW number is built and where its limits are.

## How 0sec scores on XBOW, and the caveats

**Historical gpt-5.4 union: 93 / 95 = 97.9% (ledger dated 2026-05-06).**
The consolidator unions solved challenge IDs across retained results for a model.
It does not partition this tally by black-box/white-box mode, configuration, or
independent attempt. It therefore does not establish a black-box single-shot
success rate. A replacement qualified score requires attempt-level receipts.

Caveats:

- **Single model is not single-shot.** Repeated results and retries can contribute
  to the same model's solved set; the denominator counts distinct challenges.
- **Both aggregates depend on retention.** Per-model and cross-model sets are
  affected by available artifacts and the run lookback window.
- **Costs are historical estimates with coverage limits.** The consolidator's
  ~$0.48 average includes only positive-cost results, while $5.20 divides retained
  recorded cost by union-solved challenges. Neither is a complete single-run cost.
- **CTF ≠ real repo.** XBOW challenges are small, single-vuln web apps with a
  planted flag. Solving them says nothing about
  finding a novel bug in a million-line kernel tree.
- **Cross-project scores aren't matched-conditions.** Fork, turn cap, and retry
  protocol all move the number by several points. See [Methodology](/methodology/).

The retained-artifact vs. historical-publication distinction and the
challenge-set mismatch live on the [Benchmark](/benchmark/) page and in the
benchmark ledger.

## Where the remaining gaps are

At the retained-artifact layer the unsolved set clusters into a few
recurring problem types:

| Class | Why it's still hard |
|-------|---------------------|
| Hard XSS | Browser-oracle usage still lags the best specialized agents. |
| Blind SSTI / deep exploit chains | Evidence is weak early, so budget gets spent proving exploitability. |
| Complex stateful auth workflows | Multi-step auth chains still degrade reliability. |
| Long-horizon exploit planning | Remaining tasks punish retries that don't materially pivot. |

## Design decisions the benchmark validated

- **Shell-first.** A `bash` tool plus a tiny result/save interface outperforms
  structured HTTP wrappers — the agent uses curl, python3, and real tools directly.
- **Plan then execute, with reflection checkpoints.** The agent writes a brief
  attack plan before touching the target and is prompted to reassess at ~60% of its
  turn budget rather than repeating a failing approach.
- **Turn budget.** Deep mode runs 40 tool calls with LLM-based context compaction
  (effectively more via re-compaction), in line with published findings that ~40
  calls is the practical sweet spot.
- **Concurrent subagents.** `spawn_agents` lets the lead agent fan
  out focused children concurrently (bounded fan-out, default concurrency 4) and a
  child can coordinate with its parent.
- **White-box mode.** `--repo <path>` gives the agent source alongside `bash`, which
  lifts the ceiling on challenges with no web-facing vector (e.g. credentials
  hardcoded in source). CI runs black-box and white-box independently.

## Framework vs. model

Score improvement comes from getting the framework out of the model's way — a small
tool surface, a lean prompt, and letting the model's training do the work. The
framework handles scope enforcement, context
compaction, loop detection, concurrent subagent fan-out, retry/handoff, and the
separate blind-verify step that decides which findings survive.

## Other benchmarks in scope

| Benchmark | Domain | Scale | 0sec relevance |
|-----------|--------|-------|----------------|
| [Cybench](https://github.com/andyzorigin/cybench) | Broad CTF (web/crypto/pwn/rev) | 40 challenges | Scored: 36/40 = 90.0% single-config |
| [AutoPenBench](https://github.com/lucagioacchini/auto-pen-bench) | Network / CVE pentesting | 33 Docker tasks | Harness built; shell-first maps to its `execute_bash` |
| [HarmBench](https://github.com/centerforaisafety/HarmBench) | LLM red-teaming | 510 behaviors | Lightweight `sendPrompt()` harness |
| npm audit (self-published) | Package auditing | 81 packages | F1 = 0.973; see [ablation log](/research/2026-04-11-ablation/) |

## Related

- **[0.security](https://0.security)**
- [Benchmark](/benchmark/)
- [Methodology](/methodology/)
- [Competitive Landscape](/research/competitive-landscape/)