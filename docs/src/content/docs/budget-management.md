---
title: Budget Management
description: Workflow-specific turn limits, shared cost ceilings, model-price estimates, hosted credits, and separate Jev budgets.
---

0 has several independent limits: agent turns, request timeouts, estimated model
cost, and (for hosted access) service-side credit admission. None is a substitute
for the others. The open-source harness has no software charge; provider,
subscription and execution-infrastructure costs still apply.

## Turn budgets

A turn is one agent-loop model round-trip. It can contain multiple tool calls;
it is not a single HTTP request or a fixed number of tokens. Limits apply to
individual agent sessions, not to every stage and worker combined.

The current depth presets are:

| Workflow / session | `quick` | `default` | `deep` |
| --- | ---: | ---: | ---: |
| Agentic web/deep scan attack stage | 20 | 40 | 100 |
| Native package-audit research | 15 | 40 | 60 |
| Native source-review research | 20 | 60 | 150 |
| Legacy text-loop package audit | 15 | 50 | 50 |
| Legacy text-loop source review | 15 | 50 | 100 |

Source/package verification through the shared agent runner has 20 turns on the
native path and 12 on the legacy path, independently of depth. Web discovery
uses 12 turns; other agentic discovery uses 8. Special workflows such as MCP,
kernel profiles, hunts, and per-file research have their own orchestration;
do not apply the attack-stage table to all of them.

The shared source/package agent runner accepts positive-integer overrides:

| Variable | Applies to |
| --- | --- |
| `0SEC_MAX_TURNS` | Shared runner research and verification sessions |
| `0SEC_MAX_TURNS_AUDIT` | Audit research; overrides the global value |
| `0SEC_MAX_TURNS_REVIEW` | Review research; overrides the global value |
| `0SEC_MAX_TURNS_VERIFY` | Verification; overrides the global value |

Invalid, zero, or negative values are ignored. These are not universal limits
on every command or the web attack loop. For a bounded source review:

```bash
env 0SEC_MAX_TURNS_REVIEW=30 0SEC_MAX_TURNS_VERIFY=12 \
  0 review ./authorized-repo --runtime api --depth default --cost-ceiling 5
```

The console separately exposes `--max-tool-calls` (default `20`) for tool-call
rounds per operator message. It does not configure the scan depth presets.

<span id="why-40-turns"></span>
## Turn-limit rationale

The 40-turn web attack default is not a universal optimum or a coverage
guarantee. Source/package native budgets are larger than older documentation
reported; they were revised alongside prompt caching. Increase depth only after
checking model capability, source access, tool availability and incomplete-run
diagnostics. A larger turn limit permits more work; a run that finishes early
does not consume the whole allowance.

Historically, this page justified the web attack limit with MAPTA's reported
76.9% XBOW result and internal observations of successful exploits finishing
in 10–20 turns, with few recoveries from 40 to 60. Those were rationale for an
earlier preset, not measured guarantees for today's models or other workflows.
See the [benchmark context](/research/competitive-landscape/) before comparing scores.

## Reflection checkpoints

Native-loop continuation prompts become budget-aware when the model emits no
tool calls and the loop decides it must continue:

| Budget consumed | Continuation prompt |
| --- | --- |
| At least 30% | Summarize observations and the top hypothesis |
| At least 50% | Review attempted approaches and focus the next experiment |
| At least 70% | Switch technique if the current approach is not working |
| At least 85% | Focus on the highest-confidence remaining path |

These are conditional nudges, not four guaranteed extra model calls. Separately,
both native and legacy loops inject two one-time warnings on ordinary turns:
at `ceil(maxTurns × 0.85)` and `max(1, maxTurns − 3)`. They are enabled by default;
`0SEC_FEATURE_BUDGET_WARNINGS=0` disables those two warnings, not the hard turn
limit. For a 40-turn session they fire at turns 34 and 37.

## When budget runs out

Turn exhaustion preserves partial findings and records an incomplete session.
An exhausted attack stage may still feed verification/reporting, but evidence
gates, errors and remaining cost budget determine what actually runs. Do not
interpret a partial report as completed coverage or assume every saved finding
was reproduced.

With a database attached, agent loops periodically checkpoint state every two
turns and save terminal state. Resume does not promise an exact replay of every
in-flight request. See [Scan Workflows](/scan-workflows/) for the supported
resume paths and retained evidence.

## Cost ceiling

`scan`, `audit`, and `review` accept `--cost-ceiling <usd>`. The flag takes
precedence over `0SEC_COST_CEILING_USD`; the value must be positive and finite.
There is no default dollar ceiling when neither is supplied.

```bash
0 review ./authorized-repo --runtime api --cost-ceiling 5
0 audit lodash --runtime api --cost-ceiling 2
env 0SEC_COST_CEILING_USD=3 \
  0 scan --target https://authorized.example --scope ./scope.json --runtime api
```

This is a **soft stop based on estimated model usage, not a prepaid reservation
or guaranteed invoice cap**. The native loop checks accumulated usage at turn
boundaries. Shared source/package pipelines use one `ScanCostLedger` across
research, per-file sessions and concurrent verification instead of allocating
the full ceiling to each session. In-flight requests can still finish and
overshoot the ceiling, including one outstanding turn per active session.

On a reported ceiling breach, these CLI commands retain partial results, exit
with code `4`, and use `exit_reason: "cost_ceiling_exceeded"` in the optional
machine-readable result line (`0SEC_EMIT_RESULT_LINE=1`). A cost stop is not a
clean security result. External clients, tool services, infrastructure and
separate advisory integrations are not automatically covered by this ledger.

Other commands have different stop boundaries:

- `deep-review --cost-ceiling` shares a ledger across its planner and finders;
  it is likewise an estimated-cost stop, not a reservation for outstanding work.
- `secure --cost-ceiling` must **not** be treated as a whole-workflow hard cap.
  Its repair loop checks the repair ledger between findings. Current persisted
  `costUsd` can be replaced by that repair total after initially recording
  investigation usage; missing reported usage can remain zero. The displayed
  amount is not a reliable investigation-plus-repair invoice. See
  [secure workflow limits](/scan-workflows/).

## Interpreting cost estimates

The estimator prices reported input, output and cached-input tokens using the
bundled rate table. Cached tokens are subtracted from ordinary input and priced
at the cached-input rate when known. Unknown models warn and fall back to
$3 input / $15 output per million tokens; **that fallback is not a quote**.
The model picker's unknown price is likewise not zero.

Important boundaries:

- Gateway tariffs can differ from direct-provider prices. A matching model name
  does not establish a matching bill.
- Subscription routes (ChatGPT Codex, Copilot, Code Assist and coding plans) have
  their own allowances and terms. Token-dollar estimates do not measure
  remaining subscription quota.
- Flat estimates cannot represent every long-context tier, cache-write charge,
  time-of-day discount, region or deployment tariff.
- Azure `deepseek-v4.1-flash` uses the bundled Foundry estimate of
  **$0.375 input / $0.008 cached input / $1.50 output per million tokens**,
  not direct DeepSeek `deepseek-flash` rates. See
  [Azure configuration and pricing](/api-keys/#azure-openai-configuration).
- Failed or cancelled requests can consume provider work without complete usage
  reaching the CLI. Reconcile with the provider invoice or service ledger.

For hosted access, `0 balance` reports a separate `credits-v1` account.
Claimable free credits are not spendable credits; overlapping subscription
windows must not be added together; held credits are not available balance.
Neither login nor a local dollar ceiling authorizes prepaid spending or managed
security execution. See [hosted billing and interrupted requests](/api-keys/#charging-and-interrupted-requests).

## Jev advisory budgets

Opt-in Jev evaluations have a separate budget per evaluator/workflow instance:
`0SEC_JEV_MAX_REQUESTS=100`, `0SEC_JEV_MAX_COST_USD=0.10`, and
`0SEC_JEV_TIMEOUT_MS=10000` by default. These are not a process-wide or hosted
account ceiling. The estimator uses $0.042 per million input tokens and reserves
the full 65,536-token input allowance before dispatch, including concurrent
calls. Known usage settles that reservation; unknown failed-request usage keeps
it reserved. There are no implicit retries or fallback to the chat model.

The accepted kernel-only `classifier` adapter instead enforces request/classification
counts (`0SEC_JEV_MAX_CLASSIFICATIONS=1000` by default). Its returned zero usage
does not meter external service costs. Adapter support is not a wired kernel
command prepass. Enabling a consumed feature authorizes sending its bounded
evaluation state to that provider. See
[Jev configuration](/configuration/#opt-in-jev-assistance).

## Choosing a depth

Start with `quick` for a short investigation, `default` for routine work, and
`deep` when the target warrants a larger session allowance. Read the row for
your workflow rather than assuming that deep always means 100 turns or a fixed
cost multiplier. Set a dollar ceiling and a provider-side spending policy as
separate controls.

## Non-determinism and retries

A repeated run can explore a different path. Benchmark retries and provider
transport retries are different mechanisms; neither establishes production
coverage. Repeated assessments also repeat spend and possibly state-changing
actions. Review incomplete-run reasons and authorization before rerunning.
A run with no findings does not prove a target secure.

Provider timeout/retry settings are documented under
[runtime resilience](/configuration/#runtime-resilience-and-retries).
Hosted requests with an unknown outcome are not automatically replayed.