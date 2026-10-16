# Console learning comparison: October 2, 2026

**The remembered lesson worked, but this experiment found no improvement in security results.** Both versions identified both tenant-access bugs and avoided both safe controls. The learned version used additional input tokens. No automatic promotion or performance claim follows from this result.

## Measured result

Model: `gpt-5.6-sol` through `chatgpt-codex`. Four heldout investigations reviewed the same four routes, with two repeated investigations per version.

| Across two investigations | No remembered lesson | Remembered lesson |
| --- | ---: | ---: |
| Confirmed vulnerabilities per investigation | 2 / 2 | 2 / 2 |
| False-positive candidates | 0 | 0 |
| Recall change | — | 0 percentage points |
| Model calls | 4 | 4 |
| Input tokens | 2,198 | 2,718 |
| Output tokens | 255 | 275 |
| Calls receiving the source lesson | 0 | 4 |

The separate development investigation used 3 model calls, 1,951 input tokens and 154 output tokens. Total measured model calls: 11. The learned reviews used 23.7% more input tokens, with no measured accuracy gain. Repeated observations test stability on this corpus; they do not increase the number of independent vulnerabilities.

## Experiment

Unlike the earlier tool-free source review, this experiment used real engine console sessions and tools. A development chat inspected only `platform.mjs` and saved a project-specific trust-boundary lesson through `remember_codebase`. The actual source-hash memory and shared learning database admitted the note. Four fresh console chats then inspected `platform.mjs` and the heldout `routes.mjs` through `read_file`. Baseline sessions received empty memory and learning stores. Learned sessions reused the development stores. The review corpus and development contract were frozen before the model comparison; the development chat never saw the heldout routes or labels.

The remembered lesson was provided to subsequent learned model requests, while baseline requests contained no prior lessons. Both versions could independently read the same platform contract, so the note provided a summary rather than additional source information. Neither version could save new notes during heldout review. Injected lessons remained outside persisted conversation history.

Host-owned HTTP probes independently tested the four route implementations. One verified principal owned the report; another verified principal was a manager in a different tenant. The two vulnerable routes disclosed the fixture's confidential report marker to the other tenant. The two controls denied that request. All routes accepted the legitimate owner and rejected unauthenticated requests. The model received source, not oracle outcomes or report markers. Model output could propose route IDs; it could not set a verification receipt or its own expected label.

These are synthetic authenticated-principal fixtures. They test ownership logic after authentication; they do not test a production authentication provider or JWT verification. The fixture uses an explicit test-principal header to select known identities.

## Budgets and evidence

Both review versions had the same ceilings: 16,000 turn tokens, six model calls/tool rounds and a 90-second investigation timeout. Only `read_file` was available during heldout review; development additionally allowed `remember_codebase`. There were no shell, browser, network or delegation tools. Review order was baseline/learned and then learned/baseline. The model used the engine's real provider runtime. Subscription inference did not provide a dollar-cost receipt, so cost is reported as token usage and model calls.

The result JSON records final answers, tool arguments and execution success, per-call usage, actual recall visibility, host oracle responses, source digest, complete benchmark-harness digest and compiled console-engine digest. See [the raw result](./learning-console-paired-2026-10-02.json).

## Reproduce

```sh
pnpm --filter '@0/core...' build
pnpm --filter @0/benchmark test:learning
node packages/benchmark/scripts/learning-console-paired.mjs
node packages/benchmark/scripts/learning-console-paired.mjs --live --model gpt-5.6-sol --provider chatgpt-codex --output /tmp/learning-console-paired.json
```

Without `--live`, only the local HTTP ownership probes run. The live command uses the selected provider account. Choose a model actually available to that account. The maximum is five investigations with six model calls each; the final receipt records actual usage. Each review uses a fresh console history. Fixture and private learning-state directories are temporary and are removed at the end.

## Limits

Four hand-authored routes contain two distinct vulnerable implementations in one access-control class. Repeating their reviews does not create new independent samples or support a statistical superiority claim. Both versions reach the ceiling, so this corpus cannot measure improved recall beyond that ceiling. This experiment verifies source inspection, lesson saving, project-scoped reuse and candidate accuracy on these cases. It does not establish benefit on unfamiliar projects, vulnerability classes, full agent scans, browser exploits, workflows or SmolVM execution. The model did not produce or execute the probes; the evaluator owned them.

The next decision should use a larger preregistered corpus with harder unseen cases, negative controls, independent validators, matched spend ceilings and retention checks. Preserve these receipts and report zero improvement; do not tune against the heldout examples and then reuse them as proof of learning efficacy.
