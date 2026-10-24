# Guided scans and explicit task routing

Interactive `0 scan --target https://your-authorized-target` now presents a plan
before execution. It reuses the supplied scope, recommends a goal and depth,
collects separate run count and sequential/parallel scheduling, then asks for a
total wall-clock limit and estimated USD limit. The final summary requires an
affirmative response. `--no-guided`, nonterminal output and journal resume retain
noninteractive behavior.

The limits belong to the entire plan. They are not multiplied by run count or
subagent count. Concurrent requests may settle after the estimated spending
threshold is reached; the displayed USD limit is not a provider-enforced billing
ceiling. Missing usage is unknown cost and stops cost-bounded execution. Reports
retain incomplete runs and their stop reasons.

Explicit routing uses the existing stage runtimes and operator-approved pins:

```sh
0 scan --target https://your-authorized-target \
  --model gpt-4o-mini \
  --task-model discovery=gpt-4o-mini \
  --task-model attack=gpt-4o \
  --task-model verify=gpt-4o \
  --task-model report=gpt-4o-mini
```

Model names in this example illustrate configuration syntax, not a quality or
price recommendation. Each model must be usable through the selected approved
provider connection. The running engine refuses overrides it cannot represent.
`--single-model` forces all stages to the selected parent model. No new automatic
provider fallback or task-ranking policy is enabled. Each resolved stage model is
shown in the existing progress stream.

## Deterministic verification

The CLI command tests exercise automatic planner entry, target reuse, explicit
routing options, confirmation cancellation and threading the shared deadline and
cost limit. Planner tests cover all goals, editable recommendations, separate
parallel runs and invalid input. Core scan-plan tests cover mixed-model shared
spend, interrupted runs, missing usage and preventing another request after the
cap. The budget adapter now preserves live model-selection policy.

`packages/core/src/runtime/scan-routing.integration.test.ts` executes the real
runtime and budget adapters against a controlled HTTP response fixture. Its
recorded route is discovery `gpt-4o-mini` → verification `gpt-4o` → reporting
`gpt-4o-mini`. The tool-call/result round trip carries the same authorized scope,
evidence reference and unverified state. All three calls charge one ledger,
with 300 input and 30 output fixture tokens.

This fixture validates protocol and accounting behavior. It is not a paid
provider qualification or a security-capability comparison. Issue #54's
representative security-task evaluation and live CLI qualification remain
required before claiming task-specific model superiority or enabling an
automatic recommendation policy. Provider availability, authorization, latency,
actual charges and security quality must be recorded in that study.
