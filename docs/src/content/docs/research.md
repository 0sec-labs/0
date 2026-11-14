---
title: Research
description: Index of design rationale, experiments and dated logs behind the 0 engine.
---

Design rationale and experiment records for 0. Each entry carries a status. A dated run is evidence for that configuration only. It is not a current guarantee, and it is not a shipped workflow unless it says so. Scores are dated snapshots.

Published investigations and disclosures are at [0.security/research](https://0.security/research/). For how to run research workflows, see [Specialist research](/research-workflows/). For benchmark scores and method, see [Benchmarks](/benchmark/).

## Essays

| Essay | Status | Summary |
| --- | --- | --- |
| [Shell-first rationale](/research/shell-first/) | Current rationale, historical data | Why the agent uses bash over structured tools, with A/B data on prompt length, reasoning effort and tool routing. |
| [TypeScript and Rust boundary](/research/typescript-rust-boundary/) | Current direction | Why orchestration stays in TypeScript while deterministic engines such as FoxGuard move to Rust behind stable contracts. |
| [False-positive reduction](/research/false-positive-reduction/) | Current, with historical measurements | The false-positive reduction stack, measured effects per benchmark slice and layer ordering. |
| [Finding triage ML](/research/finding-triage-ml/) | Partly shipped, partly planned | Learned triage: features, routing, the shipped v0 router and the planned classifier. |
| [Triage dataset](/research/triage-dataset/) | Current | How benchmark runs and verified findings become labeled JSONL. |
| [Model comparison](/research/model-comparison/) | Historical (2026) | Head-to-head testing of several models on XBOW challenges. Models and prices are dated. |
| [XBOW analysis](/research/xbow-analysis/) | Current context | Where the XBOW score comes from and its caveats. |

## Dated logs

| Log | Status | Summary |
| --- | --- | --- |
| [2026-05-09 Control-flow audit](/research/2026-05-09-control-flow-not-prompts/) | Historical | Audit of the agent loop against the "control flow, not more prompts" thesis, and the five fixes it produced. |
| [2026-05-08 Cost per flag](/research/2026-05-08-cost-per-flag/) | Historical | Why to publish a dollar-per-flag axis next to solve rate, and how 0 computes it. |
| [2026-05-06 HackerOne program audit](/research/2026-05-06-h1-ai-readiness/) | Historical | Analysis of 590 HackerOne programs by automation policy, scope shape and Safe Harbor status. |
| [2026-04-11 Triage ablation](/research/2026-04-11-ablation/) | Historical | The 21-profile triage ablation with methodology and links to raw artifacts. |

The kernel setup guide is [Kernel VM](/kernel-vm/).
