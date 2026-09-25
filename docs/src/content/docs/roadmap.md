---
title: Roadmap
description: Current entry points, release boundaries, and dated development plans.
---

## Current implementation pointers

Use these guides for current instructions. The dated plans below preserve earlier priorities.

| Area | Current entry point | Remaining boundary |
| --- | --- | --- |
| Interactive work | [Console](/console/) | The terminal interface for running scans and reviewing findings. |
| Multi-model work | [Configuration](/configuration/) and [API Keys](/api-keys/) | Role assignments must use models supported by the selected provider or gateway; child agents do not automatically switch provider accounts. |
| Find, verify, and repair | [Scan Workflows](/scan-workflows/) and [`secure`](/commands/#secure) | Reproduction, repair verification, publication, and overall completion are separate outcomes. Local repair executes with the worker's permissions. |
| Saved scan continuation | [Scan Workflows](/scan-workflows/) | Resume routing and available state vary by producer; it is not universal recovery for every command. |
| Findings and triage | [Commands](/commands/#findings) and [Finding Triage](/triage/) | Triage state is not proof that a vulnerability was reproduced or fixed. |
| Diff-aware review and CI | [Integrations](/integrations/) and [GitHub CI](/ci/github-action/) | Local/scripted CI support does not imply a published composite action. |
| Deterministic verification | [Verification Results](/verification-result/) | Replay requires executable inputs and valid setup; it does not cover every candidate automatically. |
| Research adapters | [Research Workflows](/research-workflows/) | Imported evidence is distinct from execution performed by 0. |
| Extensions and improvement | [Hackstore](/hackstore/) and [Improvement Plane](/improvement-plane/) | Installation, enablement, execution approval, evaluation, and promotion are distinct steps. |
| Optional Jev assistance | [Capabilities](/features/) | Opt-in advisory assistance has separate configuration and budgets; it is not a verification oracle. |


## 0cloud

0cloud has implemented CLI and server integration for authentication, enrollment,
managed scans, and schedules. A public sign-in page or implemented endpoint does
not establish account entitlement, a compatible deployed version, or qualified
end-to-end operation. The complete self-serve managed path has not been qualified
by this documentation audit. [Contact the team](https://0.security/contact/?intent=contact)
to agree access, scope, spend, and deliverables.

Before automating managed work, read the concrete client/server compatibility
limits in [`connect`](/commands/#connect) and [`service`](/commands/#service),
especially repository schedule filtering and remote cost-ceiling enforcement.

Cloud authentication supports approved managed-service commands; it does not
select a model for the local CLI.

## Desktop

**Desktop remains in development**, without a public download. Use the
[Console](/console/) for terminal work.

Documentation follows the source checkout. Check `0 --version` and
`0 <command> --help` against your installed release before using newly
documented flags.

Priorities: reliable execution, usable evidence, and orchestration.

## Retained research checkpoints

The retained XBOW aggregate is 103/104 = 99.0%; the retained gpt-5.4 cohort is
93/95 = 97.9%. Consolidation pools retained attempts and modes, so the latter
must not be presented as an isolated black-box or single-shot result.
The first scored full Cybench record is 36/40 = 90.0%.
See [Benchmarks](/benchmark/) and [Methodology](/methodology/) for denominators,
retry policies, evidence retention, and the separate older publication lines.
These measurements are historical results, not a current product acceptance test.

## August 2026 product-discovery checkpoint

**August 2026 checkpoint:** the strategy had selected no commercial vertical.
It described a scoped reasoning-and-execution platform with replayable evidence.

### Platform primitives

1. scenario / objective
2. target adapter
3. scoped tool policy
4. reasoning and execution loop
5. verifier / evidence oracle
6. replayable evidence bundle

Web testing, source review, package audit, MCP testing, and agent assurance are
applications of those primitives. New modes should strengthen one of them.

### Commercial hypotheses

- **Generic autonomous web pentesting** — a core OSS capability, but a crowded
  commercial category. Benchmark strength alone doesn't establish a paid wedge.
- **Agent-action assurance** — a candidate paid workflow: can a company prove a
  tool-using agent *cannot* perform a named prohibited action after a model,
  prompt, tool, or MCP change? The `agent-assure` command supplies the initial
  scope-bound, externally observed action primitive.
- **Managed operation** — if a workflow proves repeat use, the managed layer
  sells scheduling, protected-target access, shared evidence, triage,
  integrations, and support around the public engine. It must not depend on a
  private fork of the scanner.

### Validation before committing

For each candidate workflow, interview ten companies with a target and security
owner; sell three paid pilots; require an authorized staging target, a defined
success or prohibited action, and replayable evidence. Measure collected revenue,
remediation decisions, and repeat demand. Build blockers recurring across at least
two pilots before committing to a vertical.

## May 2026 strategy addendum

FoxGuard is now the default static lead source and the stepping stone away from
Semgrep. The direction:

1. Keep the TypeScript control plane for agent orchestration, provider
   integration, CLI/cloud contracts, benchmark loops, and fast policy iteration.
2. Move deterministic engines into Rust behind stable JSON/SARIF contracts.
3. Make FoxGuard the first engine that proves this boundary with measured lead
   quality and wall-time wins.

Trust-track implications:

- **FoxGuard validation gate** — run the Semgrep-vs-FoxGuard ablation; keep
  FoxGuard as default only if it preserves confirmed findings while materially
  improving wall time.
- **Scanner language cleanup** — migrate prompts/docs from "Semgrep findings" to
  scanner-neutral language, keeping JSON fields backwards-compatible until a
  schema migration is worth the churn.
- **Rust engine expansion** — after FoxGuard proves the boundary, evaluate secret
  scanning, dependency inventory normalization, SARIF/CBOM transforms, large-repo
  indexing, and sandbox/process helpers as Rust engines.
- **No wholesale Rust rewrite yet** — revisit only under measured runtime,
  distribution, sandbox, or multi-consumer pressure.

See [TypeScript/Rust Boundary](/research/typescript-rust-boundary/).

<span id="implemented-pending-release"></span>
## Source implementation checkpoints

These entry points exist in the source checkout. Check your installed CLI's
help and the linked guides for availability, configuration, and execution limits;
this section does not infer release status from source presence.

- **Isolated improvement workers and promotion canaries.** The `0 evolve`
  CLI provides config-driven source candidate
  proposals with explicit `allowModelSourceAccess` consent, three-lane
  evaluation (development/held-out/negative-control) in network-none Docker
  containers, content-addressed immutable snapshots, pure-function promotion
  gates, canary trials, rollback, and hash-chained registries with atomic
  artifact publication. Configured `autoPromote` controls promotion autonomy.
  Execution isolation depends on the selected worker backend and its deployment.
  [Improvement Plane](/improvement-plane/).
- **Operational feedback curation.** `0 evolve feedback capture/approve/status/release`
  for evidence-backed observations with operator-curated `ValidationFixture`
  arrays (positives, heldOut, negativeControls), source access consent, and
  content-digest drift detection.
- **Skill/router artifact bridge.** `artifact-bridge.mjs` authorizes candidate
  artifacts against the evolution registry before skill-refine or active-learning
  loops may promote them.
- `0 lens-synth --status` and `--rollback` for inspecting and retiring
  promoted overlay lenses.

<span id="recently-shipped-april-2026"></span>
## April 2026 implementation record

- **Retained artifact-backed XBOW aggregate at 103/104.** The retained
  gpt-5.4 cohort is 93/95 = 97.9%, not an independently established single-shot
  black-box result. Consolidation pools retained attempts and modes; artifact
  rotation can change which supporting runs remain available.
- **First scored full Cybench run at 36/40 = 90.0%.** Single-config (Azure
  gpt-5.4), with the recorded allowance of 3 retries per challenge, 358 attack turns, ~$14.89.
  Supersedes the older 8/10 subset.
- **Historical public XBOW line tracked separately** — 90/104 black-box, 95/104
  aggregate after purging unsupported claim residue.
- **Estimated-cost guards** — native scan loops retain partial findings and
  stop when an observed ceiling trips. In-flight work can overshoot; see
  [Budget Management](/budget-management/) for current coverage and limitations.
- **Direct OSV advisory lookup** in the npm audit pipeline — no more relying on
  `npm audit` alone.
- **Phase 4 pre-recon CVE check** for white-box mode — fingerprints the stack
  against known vulns before attacking.
- **Phase A flag-regex extractor + gate filters** — caught the XBEN-079 honeypot
  decoy (`FLAG{I'm_a_Script_Kiddie}`) before it became a silent false positive.
- **Phase B malicious-package detection** in the audit pipeline.
- **Orchestrator handshake (Phase 1)** — OSS-engine findings can be normalised and
  ingested by an orchestrator that tracks scan jobs end-to-end.
- **A/B sweep cadence** — historical overnight feature-combination sweeps.
  Consult [Research Workflows](/research-workflows/) for current entry points
  rather than assuming an older workflow still exists.

<span id="now"></span>
## Historical near-term priorities

The following goals preserve earlier planning context, not current delivery
commitments. Implemented portions are identified explicitly.

### 1. Anti-honeypot / decoy-flag heuristic

**Goal:** stop the agent declaring victory on the first flag-shaped string when
the target seeds a fake one.

**Why:** on XBEN-079 the agent submitted `FLAG{I'm_a_Script_Kiddie}` (real flag:
`FLAG{7dda4e738d29a996f343a610}`). The flag-extractor gate caught the mismatch —
but a non-CTF target could plant a decoy in `.git/config` and the agent would
submit it.

**Current implementation:** the `done` tool's decoy-shape heuristic is enabled
by default and can be disabled with `--no-decoy-detection`. It rejects a
low-confidence flag once; a repeated submission can override it. This is a
benchmark-oriented speed bump.

### 2. Statistical evaluation methodology — n=10 per cell

**Goal:** replace single-shot anecdotes with per-attempt success rates and
confidence intervals.

**Why:** the v1 sweep's single XBEN-061 solve with a `handoff,no-hiw,no-evidence`
combo looked like a winner. The v2 sweep re-ran it as a regression test — **it
failed.** That solve was noise inside a 20-40% per-attempt rate. A single solve
is an anecdote; any config recommendation from one solve is unsafe to promote.

**Deliverables:** `--repeat N` harness flag reporting success rate + CI; default
n=10 per cell before any promotion to default; per-cell cost ceiling (~$5); a
methodology page on best-of-N (what XBOW reports) vs per-attempt success rate
(what we measure).

### 3. Resumable scans

**Goal:** resume a dead long-running scan from stored state instead of
restarting.

**Why:** the repo already persists `agent_sessions` and `pipeline_events`;
restarting long agentic workflows is expensive.

**Current implementation:** `0 resume <scan-id>` and journal continuation
exist. The remaining goal is reliable recovery across all workflows. Read
[Scan Workflows](/scan-workflows/) for supported routing, state requirements,
and caveats.

### 4. Finding inbox + triage workflow

**Goal:** make findings manageable across repeated runs.

**Why:** repeated findings need dedupe, suppression, and audit history.

**Current implementation:** the `findings` command exposes grouped findings,
triage filtering, and lifecycle inspection. The CLI's human triage values are
`new`, `accepted`, and `suppressed`, separate from finding verification state.
The broader suppression-expiry, comments, and cross-run workflow described
here remains a design goal unless documented by a current command.

<span id="next"></span>
## Historical next-step proposals

### 5. Diff-aware PR scanning

**Goal:** make the GitHub Action fast enough to run on every PR — changed files
first, expand when suspicious.

**Current implementation:** `review --diff-base <ref> --changed-only` scopes
static leads and prioritization to changed files. See [GitHub CI](/ci/github-action/)
for the supported automation path. Broader PR policy and automatic fallback
behavior are goals, not implied by the presence of these flags.

### 6. Deterministic replay for every finding

**Goal:** every confirmed finding reproducible on demand.

**Deliverables:** replay from finding ID; saved exploit inputs/requests/prompts;
verifier transcript and verdict trace; shareable artifact bundle.

### 7. Multi-target orchestration

**Goal:** scan many repos, packages, or endpoints as one campaign. Concurrent
subagents already fan out **within a single run** (`spawn_agents`); this item is
the campaign-scale layer above that.

Use campaigns for multi-target research, parallel verification, and aggregate evidence.

**Deliverables:** campaign runs; worker-pool / concurrency controls; queueing and
retry policy; shared target inventory and cross-target clustering.

### 8. Local dashboard / operations shell

**Goal:** expose stored scan state as a real operator interface for running the
control plane, working the review inbox, and inspecting runtime failures.

**Current implementation:** local dashboard and console interfaces exist.
Desktop is in development; see [Roadmap](/roadmap/#desktop) for current
status. Use [Console](/console/) for the released terminal interface.

<span id="later"></span>
## Longer-term proposals

### 9. Policy packs and organisation presets

Suppressions as code; severity gates by environment; org-level runtime/model
defaults; approved attack template sets.

### 10. Richer target inventory and trend analysis

First-/last-seen attack-surface changes; recurring finding families; regression
alerts; "what changed since last green run."

### 11. Distributed workers / remote execution

The historical proposal covered remote queue workers, campaign execution, and
a shared artifact store. A hosted control plane is no longer merely hypothetical:
current managed-service implementation and qualification boundaries are described
under [0cloud](#0cloud). Broader campaign behavior remains a separate question.

<span id="non-goals-right-now"></span>
<span id="product-direction"></span>
## Development priorities

Local analysis, CI review, retained evidence, and campaign orchestration need
reproducible results and bounded workers. UI scaffolding alone establishes no
managed-service availability. EGATS remains opt-in after its unfavorable ablation.