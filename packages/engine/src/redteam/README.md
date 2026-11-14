# @0/engine/redteam

Offensive LLM/agent **indirect-prompt-injection** engine — the attack-side mirror
of `packages/bench`'s detection suite. Sweep a strategy library against a
supported mock or OpenAI-compatible chat target, judge behavior-specific
criteria, and record unique (model, behavior) breaks. For externally observable
agent actions, use the separate agent-action assurance contract below.

Built from the Gray Swan Arena "IPI June '26" run: the strategy library and the
unique-breaks engine encode what actually worked (and what didn't) against
frontier models.

## Concepts

- **Behavior** — a benign task, the untrusted vector (README, support document,
  email, forum post, …), and a `goal.proof` regex; optional `goal.criteria`
  supports semantic judging.
- **Strategy** — turns a goal into payload text. Two kinds compose:
  - *framing* (visible body): `mundane-required`, `reasoning-mimicry`,
    `fake-ci-authority`, `fake-preflight`.
  - *concealment* (hidden reinforcement): `html-comment`, `unicode-tags`
    (U+E0000 block, Claude-family), `sneaky-bits` (two-char binary, OpenAI-family).
- **Target** — `mock` (simulated easy/hard models), `chat` (any
  OpenAI-compatible endpoint). Arena/Playwright adapter is a planned add.
- **Judge** — `regexJudge` matches the transcript or reported tool-call
  arguments. `llmJudge` is implemented for semantic criteria with a caller-
  supplied `ask` function; it parses a leading YES/NO and falls back to regex
  when no criteria exists. Neither is an independent external-action observer.
- **Engine** — `runCampaign` sweeps candidates and skips a named model after
  its first break for that behavior. `runIterativeCampaign` adds a fixed
  escalation sweep for survivors. These measure unique breaks, not recurrence.

## CLI

From a prepared repository checkout:

```bash
pnpm --filter @0/engine build
node packages/engine/dist/redteam/cli.js strategies
node packages/engine/dist/redteam/cli.js gen install-package
node packages/engine/dist/redteam/cli.js run install-package  # simulated models, no network

# For an authorized real endpoint, configure LLM_BASEURL, LLM_API_KEY and
# comma-separated LLM_MODELS securely in the environment first:
node packages/engine/dist/redteam/cli.js run install-package --target chat
```

The CLI uses `runCampaign` with the regex judge; it does not enable the LLM judge,
iterative escalation automatically. Chat targets place the injected
document in a chat message; they do not provision a tool-using customer agent.

## Campaign API and budgets

`runCampaign(behavior, target, options)` returns `behaviorId`, `target`, `attempts`,
`breaks`, `brokenModels` and `attemptReports`. Attempt reports retain the model,
strategy IDs, `broken`, evidence, index and `skipped`.
A skipped row is not a new send or a safe-model result. Send/judge failures
produce non-broken error evidence; inspect it rather than counting every
non-break as a completed defense.

`maxAttempts` limits sends **per sweep**. `runIterativeCampaign` passes that same
limit to both the base and escalation sweeps, so it is not one aggregate cap
across both. `signal` is checked between sends;
the `Target.send` interface has no abort parameter, so caller cancellation does
not promise interruption of every in-flight target request.

The core `runLlmIpiAudit` wrapper runs built-in or supplied behaviors and returns
findings for breaks. Its `verified` status and fixed confidence are judge-derived
labels, not deterministic replay or state-oracle proof.
