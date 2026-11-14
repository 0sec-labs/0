---
title: Self-improvement
description: How 0 learns from past work and evaluates changes to itself, and where each change is allowed to take effect.
---

0 can keep lessons from earlier work, benchmark its own variants and evaluate proposed changes to detection workers. This is not an unattended loop that finds its own ground truth and rewrites itself. Each mechanism retains observations, proposes a change, evaluates it against criteria you own, and selects an exact version for later work. A candidate's own success claim is never an independent verifier.

Internal contracts (artifact schemas, registry events, worker protocol) live in the code under `packages/engine/src/improvement/` and in the repository design docs.

## Pick a workflow

| Need | Entry point | Default |
| --- | --- | --- |
| Keep notes about a codebase | The agent's `remember_codebase` tool, or the **Learning** view in the browser app | Lessons are untrusted hints. Verifiers exclude them. |
| Benchmark variants and gate regressions | `0 improve bench run` | Needs a labeled corpus. |
| Evaluate and promote a detection worker | `0 improve evolve run --config evolution.json` | Source access and auto-promotion are off. |
| Use an evolved finder in a review | `0 scan deep ./repo --evolution-config evolution.json` | Opt in per review. |
| Check task routing offline | `0 improve routing-qualify` | Fixture mode makes no API calls. |
| Evolve finder prompts from curated misses | `0 research lens-synth` | Needs a curated corpus. Promotion needs approval. |
| Let the agent write its own tools | `self_extend` tool | See [Plugins](/plugins/) and [Plugin security](/plugin-trust/). |

Model credentials pay for proposal generation. Guest images pay for execution. Neither replaces the other.

## Learning

Open **Memory** in the browser app sidebar (`/learning`).

- Lessons are source-linked notes saved with `remember_codebase` in authorized local CLI and app missions. Before each model request, matching lessons have their cited file hashes rechecked. Changed files and disabled lessons are excluded. Matching bytes do not prove that dependencies, build flags or runtime are unchanged, so revalidate affected conclusions when those change.
- Suggestions are automation instruction changes you can review with their run evidence before you apply them.

Finished missions stay history. They are not lessons or vulnerability labels, and they are not model training. `ZERO_DISABLE_HUNT_MEMORY=1` disables source memory.

```bash
0 improve learning status --json
0 improve learning process --limit 25 --json
0 improve learning evolve --config ./evolution.json --project /absolute/path/to/repo --json
```

All three use the local control database (`ZERO_DB_PATH` selects another one). `--project <id>` filters. Processing a local repo also imports its current source notes. The app processes pending work in small batches every five seconds, and the queue resumes after a restart. The default worker records activity without model calls. It does not spend provider credits on its own. `learning evolve` runs the source evolution below and mirrors its snapshots and receipts into Memory. Its evaluations are labeled output-fixture. Passing expected-output tests does not show better vulnerability discovery.

### Automation versions and suggestions

Saving an automation creates an immutable revision. Each run keeps its original definition. Restoring an older revision creates a new one, and stale edits are rejected. A restored definition does not authorize new targets, tools or credentials. Schedules need review after a definition changes.

If the same step fails in three separate runs after its instructions changed, Memory can suggest the instructions from an earlier version that succeeded. It reads the last 200 runs and events. Suggestions keep the same target, steps, tools, budgets and inputs. They never apply themselves. If someone edits or dismisses the automation first, applying the suggestion fails instead of overwriting. A good earlier run is operational evidence, not proof of better security.

### Isolated workspaces

Workbench VM missions can save bounded, source-linked lessons on the host before teardown. A fresh VM requests current lessons for its approved directory before model calls. Both sides check file hashes. Lessons stay out of saved mission history and grant no permissions. Host memory stores, database handles and provider credentials are never sent to the guest.

The control database, queue and knowledge stay on the selected engine. Nothing is exported automatically.

## Benchmark variants

```bash
0 improve bench run --integration core --variants ./variants.json --gate
0 improve bench diff <run-a> <run-b>
0 improve bench scoreboard --out ./scoreboard
```

`bench run` runs a variant tournament over a labeled corpus and records it in a ledger. Useful options: `--integration core|xbow|cybergym`, `--manifest <path>`, `--pass-at-k <n>`, `--max-turns <n>` (default 40), `--cost-ceiling <usd>` per attempt, `--ci-subset`, `--ledger <path>`, `--format terminal|json`. With `--gate`, the run exits non-zero if success rate drops more than `--max-success-drop` (default 0.05) or the false-positive rate rises more than `--max-fp-rise` (default 0.05) against the last green run. See [Benchmarks](/benchmark/).

## Evolve a detection worker

Source evolution proposes edits to a copy of a source snapshot, runs them in a fresh Docker container or local smolvm guest, evaluates them, and keeps immutable versions.

```bash
0 improve evolve run --config ./evolution.json --allow-source-access --no-auto-promote --json
0 improve evolve status --store ./.evolution-store --json
0 improve evolve promote --store ./.evolution-store --version <candidate-id> --json
0 improve evolve exec --config ./evolution.json --run-id <id> --input '{"n":12}' --json
0 improve evolve rollback --store ./.evolution-store --version <active-version-id>
```

| Command | Effect |
| --- | --- |
| `run` | Propose, evaluate and optionally promote. `--watch` repeats passes, and `--max-passes <n>` bounds them. A failed pass stops the watch. Budgets accumulate only within that process. |
| `status` | Active, canary and parent versions, snapshot and receipt identities, registry events. |
| `promote` | Run the required canaries against the stored candidate and activate that exact version. It does not regenerate anything. |
| `exec` | Run a pinned snapshot in an isolated worker with no network. |
| `rollback` | Retire the named active or canary version and restore its parent. `--version` is the version to retire, not the destination. |
| `reconcile` | Settle an interrupted dispatch from observed cost and an immutable receipt digest. |
| `feedback capture`, `approve`, `status`, `release` | Queue evidence-backed observations, approve them with curated fixtures, and free a claim held by a stopped worker. |

Exit code 0 does not mean a promotion happened. A run can keep rejected proposals or an `awaiting_approval` candidate.

### The config file

`evolution.json` (schema version 1) needs a `sourceRoot`, a `storePath` outside it, a Docker `image` (evolution never pulls images), `sourcePaths`, `editablePaths` inside them, a `command`, an `objective`, `computeUsdPerSecond`, and `cases`. The cases are split into lanes: `development`, `held-out` and `negative-control`, each with at least `promotionPolicy.minimumCases` distinct cases (10 by default, 3 at the lowest). Budgets are `maxModelCostUsd`, `maxEvaluationCostUsd` and `maxIterations`. `canaryTrials`, `repeats`, `allowModelSourceAccess` and `autoPromote` are optional. The schema is `packages/engine/src/improvement/config.ts`.

A minimal config, which exercises the lifecycle and is not a security benchmark:

```json
{
  "schemaVersion": 1,
  "sourceRoot": "./worker",
  "storePath": "./.evolution-store",
  "image": "node:22-alpine",
  "kind": "source",
  "sourcePaths": ["src"],
  "editablePaths": ["src/checker.cjs"],
  "command": ["node", "src/checker.cjs"],
  "objective": "Classify every integer as even or odd; classify non-integer inputs as error.",
  "allowModelSourceAccess": false,
  "autoPromote": false,
  "canaryTrials": 2,
  "repeats": 3,
  "maxIterations": 3,
  "maxModelCostUsd": 5,
  "maxEvaluationCostUsd": 5,
  "computeUsdPerSecond": 0.0005,
  "cases": [ "... at least 3 per lane, with id, lane, input and expected ..." ],
  "promotionPolicy": { "minimumCases": 3 }
}
```

The low sample floor is for a demo only. Real evaluation needs larger corpora curated independently of the model.

### Promotion gates

By default a candidate is rejected unless every check passes.

| Gate | Requirement |
| --- | --- |
| Identity and artifacts | Candidate ID matches the sealed result. Base and candidate artifacts have distinct SHA-256 digests. |
| Execution | Complete, repeatable runs. Every case the baseline passed is kept. |
| Evaluator | Identical evaluator digest before and after. |
| Evidence | At least one retained evidence reference. |
| Sample size | At least 10 distinct cases per lane by default. |
| Development lift | At least +5 percentage points in success rate. |
| Held-out lift | At least +3 percentage points. |
| Precision | Negative-control false-positive rate rises by at most 0 points. |
| Cost | Finite cost per success, at most 1.5 times the champion's. |

A passing source candidate still needs `autoPromote: true` or your approval. Promotion changes which worker future runs select. It never changes the process that is running.

### Candidate worker limits

Candidate code runs with a sealed input and explicit command, in a fresh container or guest, with no engagement credentials and no production-target network access. CPU, time, disk and model spend are bounded. Stdout, stderr, evaluator receipts and artifact digests are kept.

### Use an evolved finder

```bash
0 scan deep ./repo --evolution-config ./evolution.json
```

Each finder call in that review inherits the parent's pinned snapshot. Verification and host policy are not rewritten. `--models` cannot be combined with `--evolution-config`.

## Finder lenses

`0 research lens-synth` evolves additive finder lenses from curated misses.

```bash
0 research lens-synth --miss-input ./misses.json --promote
0 research lens-synth --status
0 research lens-synth --rollback <lens-id>
```

Other options: `--registry <path>`, `--max-register <n>`, `-m <model>`, `--watch`, `--poll-interval <ms>`, `--json`. A promoted lens changes a prompt-backed detector for newly started hunts. It does not change FoxGuard's compiled rules. Active hunts keep the lens they started with. Observation capture is not truth: source consent and curated positive, held-out and clean-control fixtures still gate synthesis.

## Autonomy and hot-reload boundaries

| Path | What changes | What stays fixed |
| --- | --- | --- |
| Finder lens overlay | New hunts load promoted lens content. | Active hunts keep their captured lens. |
| Source evolution | `evolve run --watch --auto-promote` selects a new accepted snapshot for later `evolve exec` runs. | Existing run IDs keep their snapshot and config. |
| Evolved finder | `scan deep --evolution-config` picks the active snapshot for each new review. | Verification and host policy. |
| Skills and router | Training installs exact authorized artifact bytes. | A model already loaded in another process. |
| Executable plugin | An enabled agent submits or evolves code. Later calls use the active retained version. | An invocation pins its version and declared capabilities. Admission is not measured improvement. |
| Development engine | A development console with `allowDevSourceUpdates` loads changed engine source between turns. | The UI shell, injected clients and shared dependencies. A failed build or checkpoint keeps the current engine. |
| Live harness generation | A session replaces its `agent.driver` and `ui.view` at a checkpoint. | History and accounting survive. This is not durable campaign recovery. |

Two of these run host code. The development engine path needs a console started with `ZERO_DEV_SOURCE_ROOT` and the global `allowDevSourceUpdates` setting. It defaults off and a project cannot grant it. Workspace-trusted ESM for self-extension is a separate acknowledged grant. Neither grant gives sandboxed model-written code host access, and `allowModelSelfExtension` does not enable either one. See [Configuration](/configuration/#development-engine-updates).

Rules that hold on every path:

- Keep version identities, observations and receipts across changes.
- Keep evaluation answers and credentials out of candidate snapshots.
- Do not replay tool effects that were already issued after a driver fails.
- Model-supported claims and model-only rejections stay unresolved in the shared hunt ledger.

Lifecycle checks measure orchestration. Provider behavior, sandbox execution and detection quality need their own checks.
