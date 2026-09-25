---
title: Features
description: Find the supported 0 workflow for your target, with links to command contracts, configuration, and evidence limits.
---

Choose a workflow by target, then follow its setup and authorization requirements.

## Target coverage

| Target or task | Entry point | Guide |
| --- | --- | --- |
| Web application or REST API | `scan --mode web` | [Scan Workflows](/scan-workflows/) |
| AI/LLM endpoint or MCP target | `scan` with the appropriate mode | [Commands](/commands/#scan) |
| Source repository | `review` | [Scan Workflows](/scan-workflows/) |
| Source plus a running application | `scan --repo` | [White-Box Mode](/white-box-mode/) |
| npm, PyPI, Cargo package, or OCI image | `audit --ecosystem` | [Scan Workflows](/scan-workflows/) |
| Focused source and vulnerability research | `hunt`, `deep-review`, and specialized research commands | [Research Workflows](/research-workflows/) |
| Kernel reproduction | `kernel`, `verify`, and `research` families | [Kernel VM Verification](/kernel-vm/) |
| Compiled binary evidence | `binary` and the 0verse adapter | [Research Workflows](/research-workflows/) |
| Identity and offline relationship analysis | `identity`, `adgraph`, `entragraph` | [Authorized Engagements](/engagements/) |
| Stateful agent assurance | `agent-assure` | [Adversarial Evals](/adversarial-evals/) |
| Candidate evaluation and promotion | `evolve` | [Improvement Plane](/improvement-plane/) |

Live network testing requires authorization and scope. Source review may execute
tools, download dependencies, and send model requests. Coverage depends on the target and available evidence.

## CLI flags (scan)

See [Commands](/commands/#scan) for `scan` target, scope, model, budget,
authentication, and output flags. Other commands have their own options.

### Authenticated scanning

Use `--auth` for target credentials. Model credentials use separate environment
variables. The scan command accepts a JSON value or a JSON file for bearer,
cookie, basic, or custom-header authentication. Prefer a restricted file over
putting a real token into shell history. See
[credential formats](/commands/#--auth-credential-formats) and
[Authorized Engagements](/engagements/) for engagement preparation.

### API spec import

`scan --api-spec` seeds endpoint knowledge from an OpenAPI or Swagger document.
It does not authorize the described hosts or guarantee endpoint coverage. See
[the API recipe](/recipes/#scan-a-rest-api-openapi).

### Export to GitHub Issues

`scan --export github:owner/repo` writes findings to the remote repository.
Review the destination, permissions, and sensitive evidence before use.
[Integrations](/integrations/) covers automation and publishing boundaries.

## Runtimes

The model provider handles inference. The tool executor runs actions.
Hosted model selection leaves local shell execution on your machine.

[Configuration](/configuration/) documents runtime selection and fallback.
[API Keys](/api-keys/) documents supported providers, model routing, credential
sources, and subscription authentication.

## Executors and tools

The default shell path executes on the host. Optional Docker execution and
specialized replay/VM paths have different isolation boundaries and prerequisites.
Neither scope checks nor a cost ceiling is an OS sandbox.

Available tools depend on the workflow and feature settings. See
[Configuration](/configuration/) for executor controls,
[Console](/console/) for interactive approvals, and
[Research Workflows](/research-workflows/) for tools that compile or execute
untrusted programs.

## Output formats

Supported formats vary by command. Core scan/review/audit flows expose terminal,
JSON, Markdown, HTML, SARIF, and PDF output. A local report, a saved journal,
and a deterministic verification result are different artifacts.

[Scan Workflows](/scan-workflows/) explains how to inspect and retain results.
[Integrations](/integrations/) covers CI and machine-readable output.

## Triage pipeline

Candidate generation, automated verification, and human triage have separate
evidence requirements. Available gates vary by target and workflow.
See [Finding Triage](/triage/), [Blind Verification](/blind-verification/), and
[Verification Results](/verification-result/). Skipped or unavailable checks
leave coverage unknown.

## Agent loop enhancements

The agent loop supports budgeting, context management, tool use, and feature-gated
research strategies. [Agent Loop](/agent-loop/) explains the control flow;
[Budget Management](/budget-management/) distinguishes turn limits from spend
limits; [Configuration](/configuration/) owns feature settings and defaults.

Use [Console](/console/) for interactive work. Desktop is in development; see
[Roadmap](/roadmap/#desktop) for status.

### Advisory evaluations

Jev assistance is opt-in for browser exploration, memory ranking, duplicate
assessment, and red-team feedback. It does not verify a vulnerability, authorize
an action, or replace the existing verification path.

Set `ZERO_JEV_FEATURES` to the selected comma-separated features: `browser`,
`memory`, `dedupe`, or `redteam`. Credentials alone do not enable assistance.

| Setting | Behavior |
| --- | --- |
| `ZERO_JEV_PROVIDER` | `vercel` by default (your own gateway key); `cloud` routes through the managed endpoint and bills workspace credits |
| `AI_GATEWAY_API_KEY` / `ZERO_JEV_CLOUD_TOKEN` | Credential for the selected provider; keep it out of command history |
| `ZERO_JEV_TIMEOUT_MS` | Per-request timeout; default `10000` |
| `ZERO_JEV_MAX_REQUESTS` | Per-evaluator request limit; default `100` |
| `ZERO_JEV_MAX_COST_USD` | Per-evaluator estimated budget; default `0.10`, not a customer invoice or whole-scan ceiling |
| `ZERO_JEV_BROWSER_READ_ONLY_URLS` | Exact comma-separated URLs approved for assisted navigation; engagement scope still applies |

After configuring the provider credential:

```bash
env ZERO_JEV_FEATURES=memory,dedupe \
  0 scan --mode web --target https://app.example.test --scope ./scope.json
```

Assistance sends selected observations to the evaluator. Browser assistance
hands forms, authentication, writes, and ambiguous decisions back to the main
agent. Unavailable evaluations retain the existing decision path rather than
inventing a result.

The four wired paths have different effects:

- **Browser:** `browser` action `assist` follows captured links only when the
  exact URL is operator-approved and in scope, the page is unchanged, and the
  selection probability is at least `0.95`. It returns a handoff, not a finding.
- **Memory:** ranks prior human-review context; the verifier still has to assess
  current evidence. Prepared feedback remains scan-local.
- **Dedupe:** can add canonical/cluster mappings for high-confidence
  exact-location, same-defect, same-fix pairs. Original evidence is retained;
  ambiguous pairs use the existing model dedupe path.
- **Redteam:** records advisory attempt labels and evaluator usage. Regex/LLM
  judges, or the separate action oracle in agent assurance, retain the verdict.

Invalid feature names, missing credentials and invalid budgets are configuration
errors, not a promise of silent fallback. Request failures have no automatic
retry or substitute chat-model fallback. Evaluator usage is separate from
main-model usage; the cost ceiling reserves estimated request cost and is not a
whole-engagement accounting limit.

The shared evaluator API also recognizes the `kernel` feature, used by the
`0sec kernel jev-prepass` command. That support alone does not wire an
automatic kernel prepass into the assessment commands described here.

Managed workers receive a separate scan-bound capability and endpoint from
0cloud. Installing this engine does not enable the hosted service, establish
account entitlement, or prove that a deployed worker uses this version.

## Benchmarks

Published benchmark scores, configurations, and caveats are in
[Benchmarks](/benchmark/) and [Methodology](/methodology/). Historical research
results are not current-target guarantees.

<span id="unified-soc-story"></span>
## Related products

See [Integrations](/integrations/) for connected tools and
[managed work](/getting-started/#managed-work-and-onboarding) for separate
scoping, access and terms. The interactive console uses your model connection.
See [Commands](/commands/) for the full CLI reference.