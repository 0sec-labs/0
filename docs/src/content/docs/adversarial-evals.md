---
title: Adversarial evals
description: Attack-driven evaluation of AI systems, with scoped execution and replayable evidence.
---

0 evaluates AI systems by attempting scoped attacks and recording evidence.

## What's shipped

Three distinct implementations answer different questions:

| Path | What it evaluates | What a success means |
| --- | --- | --- |
| `@0/benchmark` adversarial harnesses | Synthetic MCP tool misuse, indirect injection and persistence cases | The scanner detected the expected finding categories in a controlled fixture |
| `@0/llm-redteam` campaigns | Generated indirect-injection payloads against mock or OpenAI-compatible chat targets | The configured regex/LLM judge matched a behavior's success criterion |
| `0 agent-assure` | A customer-owned agent adapter, its MCP inventory and an independent state observer | A complete observer result reports the prohibited action as observed or not observed |

These are not interchangeable scores. A synthetic detection pass is not proof
that an arbitrary production agent is secure, and a matched transcript is not
proof that an external action executed.

The benchmark package has scripts for local fixtures:

```bash
pnpm --filter @0/benchmark adversarial-tool-misuse --json
pnpm --filter @0/benchmark adversarial-indirect-prompt-injection --json
pnpm --filter @0/benchmark adversarial-persistence --json
```

Use a prepared repository development environment. These runners start local
fixture servers and exercise `runMcpSecurityChecks`; they do not call a real
frontier model. Tool-misuse and indirect-injection `passed` means expected
categories were returned. Persistence also requires a prompt-injection finding
on its synthetic later-read surface (`replayCompromised`).

For live agent-action prerequisites, scope, invocation and result meanings, see
[Agent-action assurance](/research-workflows/#agent-action-assurance-agent-assure).
All three endpoints must be authorized and must implement the required adapter
contracts. The bundle binds target/policy/model/tool versions and evidence hashes;
it is not a recording that can execute itself against an arbitrary target.

<span id="why-it-matters"></span>
## Evaluation goals

Choose an explicit attack objective and observable success criterion before the
run. Record failed and incomplete attempts as well as breaks, so a missing
observation is not reported as a successful defense.

## Target classes

- LLM / agent HTTP APIs
- MCP servers
- tool-using agent backends
- authenticated staging apps with AI features enabled

<span id="what-makes-it-different-from-generic-evals"></span>
## Verification

- For action claims, use a state observer rather than model text alone.
  `agent-assure` returns `inconclusive` while the observer remains incomplete,
  even if it has provisionally reported `observed: true`; endpoint errors are
  `error`, not a negative observation.
- A completed `not_observed` applies to the tested scenario and observation
  window, not every possible attack.
- Repeat independently to measure recurrence. Red-team campaigns stop retrying
  a model/behavior pair after its first break, so their unique-break count is
  **not** a recurrence rate.
- Retests can bind a prior manifest with `--baseline`; inspect configuration
  changes rather than comparing unlike target versions.

### Jev advisory feedback

The integrated IPI audit can opt into Jev `redteam` feedback. It reports
`explicit-refusal`, `partial-compliance`, `attempted-prohibited` or `ambiguous`
with probability and evaluator usage. Feedback does not change `broken`;
unavailable evaluations remain advisory and cannot erase independent evidence.
The current iterative campaign uses a fixed escalation candidate set, not an
adaptive strategy chosen by those labels.

The standalone red-team CLI does not wire the evaluator from environment
variables; use the package's feedback hook or the integrated core audit.
See [Features](/features/#advisory-evaluations) for opt-in data egress and budgets.

<span id="building-on-the-wedge"></span>
## Planned extensions

These concrete harnesses do not constitute one generic adversarial-eval command
covering every target class. Broader target adapters, recurring managed campaigns
and unified recurrence reporting remain separate work.

<span id="report-differences-from-a-pentest"></span>
## Report fields

The shipped fixture reports include per-case finding categories, pass/fail and
duration. Campaign results include unique breaks and per-attempt reports.
Agent-action bundles include versioned target metadata, oracle outcome,
redaction and hashed artifacts. A broader adversarial-eval report should also capture:

- target class and environment
- attack objective
- recurrence across runs
- whether the failure is specific to agent/tool composition
- whether it's an authorization, tool-use, or instruction-hijack failure

<span id="relationship-to-0-cloud"></span>
## Product scope

Use the local harness and your configured model connections for these workflows.
Hosted model transport still leaves tools in the chosen execution environment;
managed execution requires separately scoped access and terms. The website's
find/verify/fix product organization does not establish that every path performs
universal reproduction or that recurring managed evaluation is qualified by this
repository. See [Features](/features/#related-products) and [Roadmap](/roadmap/).