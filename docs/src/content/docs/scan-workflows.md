---
title: Scan Workflows
description: Choose a scan or source review, authorize it, inspect saved findings, verify evidence, and validate a source fix.
---

[Commands](/commands/) is the exhaustive flag reference;
[Configuration](/configuration/) covers runtime and configuration resolution.

## Choosing a target path

| Task | Command | Boundary |
|---|---|---|
| Web application | `0 scan --target https://staging.example.com --scope ./scope.json` | Active network assessment |
| MCP endpoint | `0 scan --target mcp://server.example.com --scope ./scope.json` | Active MCP assessment |
| Local source or Git repository | `0 review ./my-app` | Source review; preparation and tools can access the network |
| npm package | `0 audit express` | Package acquisition and analysis |
| Deeper repository investigation | `0 review ./my-app --depth deep` | Agent-led source review; inspect reported coverage |
| Seedless specialized review | `0 deep-review ./my-app` | Multi-lens discovery; survivors remain leads |
| Repository investigation through repair | `0 secure ./my-app --test-command "npm test"` | Committed source, executable probes, disposable checkouts in the current worker |
| Domain inventory | `0 recon example.com --json` | CT/DNS lookups and HTTP probes, not a vulnerability verdict |
| Entra ID posture | `0 identity --tenant TENANT_ID --json` | Read-only Microsoft Graph collection with operator-supplied credentials |
| Fix-seeded variant hunt | `0 hunt --source ./linux --seed ./security-fix.patch` | Source investigation; output remains leads to verify |

Explicit commands avoid ambiguity in bare-target routing. `scan --mode` selects `probe`, `deep`, `mcp`, `web`, or worker-driven `http_audit`. A review target profile is different: `review --target c-library ./libfoo` selects the C-library review path, not a URL.

For variant hunting, specification checks, fuzzing, binaries, and kernel workflows, see [Research Workflows](/research-workflows/).

The website's network → web/API → AI → source/dependencies → runtime/OS/kernel
taxonomy describes missions, not a single scan that covers every layer.
Choose the command and its evidence contract: identity/graph analysis does not
exploit a network service; a source-review lead does not establish a live exploit;
kernel/VM execution needs separately provisioned artifacts. These CLI workflows
run in your environment. Hosted model transport does not provision a managed
execution worker.

## Authorization and scope

`scan` requires an engagement scope for HTTP, HTTPS, and MCP targets, including localhost. Worker-driven `http_audit` instead builds its policy from operator-provided configuration. Neither `--require-scope` nor its absence is a way to bypass the live-target requirement.

Start with the schema and matching rules in [Scope & Authorization](/scope/). Authorize only the hosts and activities covered by your engagement. Ordinary scope rules match hostnames, not paths or ports; do not encode a path restriction as a hostname rule.

```bash
0 scan --target https://staging.example.com --scope ./scope.json
```

Scope is an application-level policy, not an OS sandbox. Source review and package audit do not require a live-target scope file, but can acquire dependencies, clone repositories, or execute tooling. Run untrusted inputs on a disposable worker without unrelated credentials.

### Attribution and engagement posture

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --attribution-header "X-Customer=acme-corp" \
  --attribution-ua "pentest-engagement" \
  --engagement-profile conservative
```

The conservative posture changes request behavior, rate defaults, and WAF-evasion behavior. `--no-waf-evasion` explicitly disables the adaptive evasion path. These settings do not grant authorization. See [Authorized Engagements](/engagements/) for precedence and limits, rather than assuming every setting follows one global merge rule.

## Authentication and runtime

Provider credentials pay for model calls. Target credentials authenticate to the assessed application. Cloud login is a separate credential flow.

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --auth ./auth.json --api-spec ./openapi.yaml --depth deep
```

`--auth` accepts a JSON object or a file containing one. Supported forms include:

```json
{"type":"bearer","token":"your-target-token"}
```

```json
{"type":"cookie","value":"session=your-session-cookie"}
```

```json
{"type":"basic","username":"test-user","password":"your-test-password"}
```

```json
{"type":"header","name":"X-API-Key","value":"your-target-api-key"}
```

Keep credential files out of version control and prefer a file over secrets in shell history. [API Keys](/api-keys/) covers provider authentication; [White-Box Mode](/white-box-mode/) covers adding `--repo` source context to a live assessment.

## Depth and cost controls

`--depth quick`, `default`, and `deep` select different investigation budgets. They are not guaranteed wall-clock deadlines, and a clean result does not prove the absence of vulnerabilities.

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --depth quick --cost-ceiling 5 --rate-limit 2
```

`--cost-ceiling` bounds tracked model spend. `--timeout` is not a universal command deadline. Rate limits, provider/runtime billing, and partial-run behavior have separate contracts; see [Budget Management](/budget-management/).

### Optional capabilities

`scan --features` enables supported feature tokens. `fp-moat` is a preset;
it does not claim every layer ran or that all remaining findings are reproduced.

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --features fp-moat
```

Inspect per-finding triage provenance. A skipped layer and an unrecorded layer are different. [Features](/features/) lists current toggles; [Finding Triage](/triage/) explains the evidence gates.

Jev assistance is separately opt-in through `ZERO_JEV_FEATURES`, not enabled by
possessing a provider key. In this workflow it can assist browser navigation,
memory ranking, or semantic deduplication. It does not grant scope, confirm a
vulnerability, or turn a duplicate match into verification. Browser assistance
also requires explicit scope and operator-approved read-only URLs; ambiguous
steps, forms, writes, and authentication return to the main model.
Review data egress and the separate Jev request/cost limits in
[Configuration](/configuration/) before enabling it.

## Output formats and saved state

The default output is `terminal`. `json`, `md`, and `sarif` support machine-readable or text exports:

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --format json > scan.json
0 review ./my-app --format sarif > results.sarif
```

HTML and PDF output write a timestamped report under the system temporary directory and print its path. Redirecting stdout does not relocate the generated report. `scan` does not register `--report-path`; copy the emitted file to durable storage. See [Integrations](/integrations/#report-formats).

### SQLite database

Current scan storage is run-local: by default `~/.0/runs/<scan-id>/state.db`, subject to the configured state root. `--db-path` selects an explicit database. Do not assume every command uses a single `~/.0/0sec.db`.

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --db-path ./engagement.db
0 history --db-path ./engagement.db
0 findings --db-path ./engagement.db
```

Keep the database and associated run artifacts when handing off or resuming work. Cloud engagement IDs, console sessions, and scan IDs are not interchangeable.

## Viewing and triaging findings

Use the same database that holds the scan:

```bash
0 findings --db-path ./engagement.db
0 findings show FINDING_ID --db-path ./engagement.db
0 findings accept FINDING_ID --db-path ./engagement.db
0 findings suppress FINDING_ID --db-path ./engagement.db
0 findings reopen FINDING_ID --db-path ./engagement.db
```

Replace `FINDING_ID` with the recorded ID or supported unique prefix. Accepting or suppressing a finding records a human decision; it does not execute a verifier.

For false-positive feedback and durable memories:

```bash
0 triage mark-fp FINDING_ID --reason "Known test-only behavior" --db-path ./engagement.db
0 triage memory add --finding FINDING_ID --reason "Known test-only behavior" --db-path ./engagement.db
0 triage memory list --db-path ./engagement.db
0 triage memory remove MEMORY_ID --db-path ./engagement.db
```

Review request/response evidence, source locations, lifecycle state, verifier outcomes, and triage provenance together. Persisted rows and discovery leads are not automatically confirmed findings.

## Resuming vs replaying

### Resume — continue execution

```bash
0 resume SCAN_ID --db-path ./engagement.db
0 resume SCAN_ID --db-path ./engagement.db --format json
0 resume SCAN_ID --db-path ./engagement.db --branch-from 12
```

Resume requires compatible persisted scan state. Journal-based branching also requires the relevant journal entries. A JSON report alone is not a resumable checkpoint. The standalone resume command supports specific persisted target routes, not every research or console workflow.

For a live scan that needs its explicit scope supplied again, use the scan entry point:

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --db-path ./engagement.db --resume SCAN_ID
```

Do not assume standalone resume restores target credentials or authorization that are absent from its options. Console continuation has a separate contract in [Console](/console/).

### Replay — render stored results

```bash
0 replay
0 replay --scan SCAN_ID
0 scan --target https://staging.example.com --replay
```

Replay renders saved findings; it does not launch a fresh assessment or independently reproduce the vulnerability. `verify` is a different operation.

The `scan --replay` spelling still requires Commander’s `--target` option;
it renders the latest row from the selected database, not a new scan of that
argument. Prefer the standalone `replay` command for saved-result viewing.

## Verification and evidence

[Blind Verification](/blind-verification/) explains independent agent
verification. Deterministic replay executes a finding, fixture, or reproduction
bundle and records concrete assertions. Verification availability depends on the
selected path.

<span id="explicit-verification-with-0sec-verify"></span>
### Explicit verification with `0 verify`

```bash
# Execute a finding with the selected runner.
0 verify finding.json --runner docker

# Replay vulnerable and patched snapshots from a reproduction bundle.
0 verify --bundle ./bundle-dir --runner docker

# Use the separate kernel-finding verification path.
env ZERO_KERNEL_VERIFY=1 0 verify \
  --kernel-finding finding.json --kernel-tree ./linux
```

A scan report containing many findings is not itself a single `finding.json`. Preserve the selected finding's executable verification data and target context. The Docker runner requires its runtime prerequisites; local execution runs on the host. Kernel execution requires its own setup in [Kernel VM Verification](/kernel-vm/).

Docker replay defaults to networking disabled. HTTP replay requiring a bridge
or custom Docker network must explicitly select `--docker-network` and provide
`--scope`; that network-enabled path permits HTTP steps only. A local runner
instead executes on the host. Choose the runner for the finding's executable
steps rather than assuming Docker can reach a remote application by default.

The fixture path is documented with a complete invocation in [Verification Results](/verification-result/#cli-path-traversal-example). Reproduction bundles, runner-based replay, legacy PoC-step execution, and kernel verification have different result contracts. Inspect the emitted JSON and the mode's exit semantics rather than interpreting every exit `2` as the same condition.

A negative replay result can mean the tested environment differs from the original finding. An inconclusive or failed setup is not evidence that a vulnerability is fixed.

## Fix workflow

`fix` takes a **clean local Git worktree**, not a finding file as its positional argument. Select one reproduced source finding, provide its verification contract, and supply an explicit regression command.

```bash
0 fix ./my-app --finding ./finding.json \
  --test-command "npm test" --output ./validated.apply-patch
```

The external finding must carry `verificationSpec` and a scoped source-file
reference. It must also carry `verification_result.status: "reproduced"` (or the
supported camel-case result field); otherwise pass
`--verification-result ./verification-result.json`. The spec must reproduce the
current vulnerable source state before patching. Specs with a `behavior` section
are rejected by this source-fix runner because they require a provisioned target;
the `secure` behavioral lifecycle is a different contract. Alternatively select
a persisted finding with `--finding-id` and `--db-path`.

The workflow generates and checks a candidate in an isolated worktree. `--output` writes validated **apply_patch DSL**, not a standard unified diff. By default it does not apply the candidate to the original worktree.

```bash
0 fix ./my-app --finding ./finding.json \
  --test-command "npm test" --apply
```

Only use `--apply` when you intend to modify the original repository. The regression command itself executes code; a separate worktree is not an OS sandbox.

| Exit | Meaning |
|---|---|
| `0` | Validated candidate, or applied and retested |
| `1` | Not fixed |
| `2` | Precondition failed or error |

See [Commands — fix](/commands/#fix) for the complete prerequisite and option reference.

## Repository lifecycle with `secure`

Use `secure` when you want discovery and behavioral repair in one repository
workflow, rather than supplying the single reproduced finding required by
`fix`. Commit the source you want assessed: local inputs are cloned from Git,
so uncommitted edits are not the investigation baseline.

```bash
0 secure ./my-app \
  --setup-command "npm ci" \
  --test-command "npm test" \
  --state-dir ../my-app-secure \
  --runtime api --timeout 3600000 --cost-ceiling 10 > secure-result.json
```

Choose setup and regression commands appropriate to the project. Setup must
preserve tracked source. The workflow investigates a managed checkout, checks
baseline tests, generates a behavioral probe with a legitimate-use control,
freezes that probe, and tests candidate patches. A repair is `verified` only
after regression tests and the frozen probe also pass in a fresh patched
checkout. This is fresh-checkout replay, not a guarantee that a different model
independently invented the reproducer or that all repository vulnerabilities
were found.

Inspect `status`, `errors`, every finding's repair outcome, `baseline`,
`verification`, and artifact paths together. The current aggregate `completed`
status can coexist with explicitly blocked findings or retained errors; exit
`0` is not an all-findings-fixed certificate. CLI exits are `0` completed,
`2` blocked, `3` failed, and `130` cancelled.

`costUsd` reports available metered model usage, not a hosted-service price or
proof of completion. Investigation completion now supplies metered cost, but
the current repair loop replaces that total with its own ledger; totals across
phases/resumes can therefore be incomplete. Repair ceiling checks occur between
findings and do not include all investigation/prior-run spend. Missing usage is
not evidence of a free call. Treat `--cost-ceiling` as cooperative accounting,
not a provider-enforced whole-workflow billing cap. Likewise, investigation does
not accept the workflow's cancellation signal directly, so timeout/cancellation
may not take effect until that pipeline returns.

Retain the state directory, including per-finding `probe.json`, `baseline.json`,
`verification.json`, `manifest.json`, and command logs when produced.
`changes.diff` is a Git diff; `candidate.apply-patch` is apply_patch DSL.
These differ from `fix --output`, which writes only the validated DSL.

```bash
# Retry a compatible interrupted/blocked/failed run with the same configuration.
0 secure ./my-app --setup-command "npm ci" --test-command "npm test" \
  --state-dir ../my-app-secure --runtime api \
  --timeout 3600000 --cost-ceiling 10 --resume
```

Resume checks the source revision and configuration identity. Completed or
cancelled runs require a fresh run instead. Without `--resume`, the same state
directory starts fresh and can reset/clean its managed checkout: do not keep
manual edits there. Secure state is not a `scan --db-path` checkpoint.

Add `--publish` only when authorized to push repair branches and create GitHub
PRs, with authenticated `gh` and repository credentials available. Publication
selects verified repairs; it does not merge or deploy them. By default artifacts
remain local. Setup, tests, and model-generated probes execute in the current
worker; disposable checkouts are not containers or an OS sandbox.

## Package and source workflows

```bash
0 audit express --package-version 4.18.2
0 audit requests --ecosystem pypi
0 audit serde --ecosystem cargo
0 audit alpine:3.20 --ecosystem oci

0 review ./my-app
0 review https://github.com/your-org/your-repository
0 review ./my-app --diff-base origin/main --changed-only
0 review --target c-library ./libfoo --depth deep
0 review --target linux-kernel ./linux
```

Use the ecosystem and version actually covered by your authorization. `--changed-only` narrows the documented review path; it is not proof of whole-repository coverage. Ordinary review uses the source-review agents at every depth. Agents can delegate scoped investigations through the same worker tree rather than invoking a separate file-review engine.

`deep-review` remains an explicit research command for evaluated finder lenses and evolved source finders. It is not the implementation of `review --depth deep`, and does not share all of `review`'s options.

## Export and disclosure

GitHub export and PR emission are external writes and require repository authorization and credentials:

```bash
0 scan --target https://staging.example.com --scope ./scope.json \
  --export github:your-org/security-findings
0 scan --target https://staging.example.com --scope ./scope.json \
  --emit pr --base main --dry-run
```

**`--dry-run` controls PR emission only. The scan still runs.** It is not a network-free preview or cost-free planning mode. Review [Integrations](/integrations/) and [GitHub CI](/ci/github-action/) before enabling automatic external writes.

## Troubleshooting

- **Scope refusal:** supply a valid engagement scope; do not remove the target protocol to bypass authorization checks.
- **Missing findings or scan:** check the run ID, state root, and selected `--db-path`.
- **Provider error:** use [API Keys](/api-keys/) and [Configuration](/configuration/); cloud login does not automatically configure a model provider.
- **Interrupted or budget-limited run:** inspect completion/error state and retained artifacts before deciding whether resume is supported. Zero findings from an incomplete run is not a clean pass.
- **Verification cannot execute:** inspect the mode's prerequisites and errors. Changing a finding's human triage state will not repair an executable verification contract.
- **Fix refuses:** check the clean Git worktree, source finding, verification evidence, and explicit regression command. Do not bypass preconditions by relabeling a finding.

For detailed runtime diagnosis, see [Troubleshooting](/troubleshooting/). For every command's arguments and options, use [Commands](/commands/) or `0 COMMAND --help` for your installed release.
