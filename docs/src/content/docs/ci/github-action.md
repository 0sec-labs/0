---
title: GitHub CI — run 0 in CI
description: Choose managed GitHub App reviews or run the CLI in your own trusted GitHub Actions workflow, with explicit credentials, artifacts and gates.
---

There are two different integrations:

- **Managed GitHub App:** an enrolled Cloud organization grants repository
  access and configures review policy. The service receives GitHub events and
  dispatches managed reviews. This is not a workflow running with your provider
  key on a GitHub Actions runner.
- **Self-operated Actions:** install 0 or use its container, supply your own
  supported model access, and run the CLI on your runner. No Cloud account is
  required for BYOK. You own runner isolation, credentials, cost and output
  handling.

A dedicated composite action has not shipped. Invoke the CLI directly; the
repository's action-schema design tests are not an installable action.

## Managed GitHub App

For provisioned Cloud organizations, use the organization's **Integrations**
page to install the App and select the authorized repositories. GitHub sign-in
alone does not grant repository access. Confirm the organization's review
capability, budget and repository policy before enabling automation.

The reviewed Cloud integration implements pull-request and push review
handlers. Repository policy controls enablement, PR versus push scans, branch
allowlists, draft PRs and skip labels. Reviews carry repository and base/head
revision context, and the integration posts review status/results back to
GitHub. Do not infer that every GitHub event causes a scan or that a successful
review means every finding has a reproduced exploit.

Hosted-model access is a separate account capability: an inference-only
organization cannot enqueue managed reviews. The existence of the public
[Cloud login](https://cloud.0.security/login) is not proof of your organization's
App enrollment, worker readiness or plan entitlement. Use
[Contact](https://0.security/contact/?intent=contact) to confirm current access;
[pricing](https://0.security/pricing/) distinguishes hosted models from managed
execution.

## Container-based workflow

The `ghcr.io/0sec-labs/0sec` image includes the CLI, Node 24, FoxGuard, pentest
and identity tooling. A job container uses shell steps; the image's normal
`docker run` entrypoint invokes the CLI directly.

This minimal example is **manually dispatched from a trusted workflow/ref**.
It is not a policy for executing arbitrary contributor code:

```yaml
# .github/workflows/0sec.yml
name: "0 security review"
on:
  workflow_dispatch:

permissions:
  contents: read
  security-events: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    container: ghcr.io/0sec-labs/0sec:latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - name: Review authorized code
        run: 0 review . --runtime api --depth quick --cost-ceiling 5 --format sarif > results.sarif
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - name: Preserve report
        if: always() && hashFiles('results.sarif') != ''
        uses: actions/upload-artifact@v7
        with:
          name: 0sec-results
          path: results.sarif
          retention-days: 14
      - name: Upload SARIF
        if: success() && hashFiles('results.sarif') != ''
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: results.sarif
```

The example uses `latest` for discoverability. Pin a reviewed release/image
digest for reproducible or privileged CI. Review generated output before
publishing it: a failed process can leave an empty or partial file, and a
nonempty file is not proof of valid SARIF.

The image runs as `ubuntu` (UID 1000). Ensure mounted workspaces are readable
and report directories writable. Nonroot execution is not a substitute for
isolating untrusted code, restricting egress or removing unnecessary secrets.

### CI-friendly flags

| Flag | Purpose |
| --- | --- |
| `--diff-base <ref>` | Select the Git base for diff-aware review; fetch that commit first. |
| `--changed-only` | Restrict static-scanner leads and prioritization to changed files; not a sandbox or a guarantee that context outside the diff is never read. |
| `--format sarif` | Emit SARIF for code scanning. |
| `--format json` | Emit the structured report for your own gate/processing. |
| `--depth quick` | Use the quick review budget. |
| `--cost-ceiling <usd>` | Review's model-cost limit; inspect partial results if the limit is reached. |
| `--timeout <ms>` | Per-tool timeout, not a whole-job deadline. Set Actions `timeout-minutes` separately. |

### SARIF upload

Use `github/codeql-action/upload-sarif@v4` for valid SARIF. Results appear in
**Security → Code scanning**, subject to repository permissions and GitHub code
scanning availability. Uploading SARIF does not itself implement your finding
severity gate. Retain the structured report and execution failures separately
so a failed or incomplete review cannot be mistaken for a clean one.

## Binary-based workflow

When the full image is unnecessary, install the release binary and add its
installation directory to `PATH`:

```yaml
- name: Install 0
  run: |
    curl -fsSL https://raw.githubusercontent.com/0sec-labs/0sec/main/install.sh | bash
    echo "$HOME/.0sec/bin" >> "$GITHUB_PATH"
- name: Run review
  run: 0 review . --runtime api --cost-ceiling 5 --format sarif > results.sarif
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The installer verifies release checksums and installs FoxGuard for supported
platforms. For a reproducible pipeline, review/pin the installer revision and
set `RELEASE_BASE_URL` to the selected release's download URL; do not assume a
mutable `main` installer or `releases/latest` is a version pin. Binary install
does not provide every external tool included in the container.

## Source-build workflow

For an explicitly trusted source revision:

```yaml
- uses: actions/setup-node@v5
  with:
    node-version: 24
- run: corepack enable && pnpm install --frozen-lockfile && pnpm build
- run: node packages/cli/dist/index.js review . --runtime api --format sarif > results.sarif
```

Dependency installation and build scripts execute repository code. Do not use
this path to build an untrusted PR with provider keys or privileged tokens
available. A separate, trusted reviewer binary avoids bootstrapping the tool
from the code under review, but does not by itself isolate later tool execution.

## Scripted action wrapper

`scripts/run-github-action.sh` and `scripts/render-github-action-output.mjs`
remain in the repository as integration helpers. They are not the active
self-review workflow or a published composite action.

The wrapper expects `0sec-cli` on `PATH`, Node, `GITHUB_OUTPUT`, and an action
root through `0SEC_ACTION_ROOT` or `GITHUB_ACTION_PATH`. The release installer
and current container expose `0`/`0sec`, not `0sec-cli`; copying this script into
an ordinary installed-CLI job is therefore not a turnkey integration. Prefer
the direct commands above unless you deliberately provide its expected runner
layout.

### Wrapper inputs

| `INPUT_*` variable | Default | Accepted values / purpose |
| --- | --- | --- |
| `INPUT_MODE` | `review` | `review`, `audit`, `scan` |
| `INPUT_PATH` | `.` | Review path |
| `INPUT_PACKAGE` | — | Required audit package |
| `INPUT_TARGET` | — | Required scan target |
| `INPUT_SCAN_MODE` | `probe` | `probe`, `deep`, `mcp`, `web` |
| `INPUT_DEPTH` | `default` | `quick`, `default`, `deep` |
| `INPUT_RUNTIME` | `api` | `api`, `claude`, `codex`, `gemini`, `auto` |
| `INPUT_TIMEOUT` | `300000` | Per-tool timeout in milliseconds |
| `INPUT_FORMAT` | `json` | Select primary output: `json` or `sarif`; both files are generated |
| `INPUT_SEVERITY_THRESHOLD` | `high` | `critical`, `high`, `medium`, `low`, `info`, `none` |
| `INPUT_THRESHOLD` | `0` | Allowed count at or above the severity threshold |
| `INPUT_REPORT_DIR` | `0sec-report` | Output directory |

The wrapper stores `report.json`, `report.sarif` and `0sec.stderr.log`. The
renderer writes `report-file`, `json-report-file`, `sarif-report-file`,
`total-findings`, `qualifying-findings`, `should-fail`, `gate-message` and
`comment-body` to `GITHUB_OUTPUT`. It does **not** post a PR comment or write the
Actions job summary itself.

`should-fail` is true when the qualifying count **exceeds** `INPUT_THRESHOLD`;
`none` disables that calculation. The renderer does not exit nonzero for the
gate. A caller must explicitly enforce that output. The wrapper also continues
after a nonzero CLI exit if a report exists, so a finding-count gate alone does
not preserve all execution failures. It has no cost-ceiling or diff-base input;
use direct CLI invocations when you need those controls.

## Provider credentials

Pass the selected provider's credentials as step-scoped repository/environment
secrets, not literal YAML values. Use an explicit provider/runtime/model when
multiple credentials are present so CI does not depend on accidental fallback.

| Provider | Credential example |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_MODEL` |
| Z.ai | `Z_AI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| ChatGPT Codex | `0SEC_CHATGPT_OAUTH_REFRESH_TOKEN` |

See [API Keys](/api-keys/) for provider requirements, account restrictions and
fallback order. Subscription authentication is not a promise that unattended
CI is permitted by that provider. Hosted model access requires separate Cloud
account compatibility; it still does not move local tools off the runner.

## Example: full diff-aware PR review

For a **trusted and approved** pull-request job, fetch the base and pass it as
an environment variable rather than interpolating contributor text into shell
source:

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
    persist-credentials: false
- name: Review the approved diff
  run: |
    0 review . \
      --diff-base "$BASE_SHA" \
      --changed-only \
      --runtime api \
      --depth quick \
      --cost-ceiling 5 \
      --format sarif > results.sarif
  env:
    BASE_SHA: ${{ github.event.pull_request.base.sha }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

This is a step excerpt, not a safe untrusted-PR trigger policy. Configure the
approval and isolated execution lane before adding it. Never use
`pull_request_target` to check out and execute fork code with privileged
secrets. Checking that a PR comes from the same repository is not a complete
trust policy either.

## Example: npm package audit

```yaml
- name: Audit a selected package
  run: 0 audit lodash --ecosystem npm --runtime api --depth quick --format sarif > audit-results.sarif
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

This audits the named package; it is not automatically a review of every entry
in your application's lockfile. Treat package contents and any reproduction
execution as untrusted inputs.

## Example: live target scan

Provision a reviewed scope file using the [scope schema](/scope/), confirm the
target is reachable from the runner, and authorize any side effects first:

```yaml
- name: Scan an authorized staging environment
  run: |
    0 scan --target https://staging.example.com \
      --scope scope.json \
      --mode deep \
      --runtime api \
      --format sarif \
      --timeout 600000 > scan-results.sarif
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

A per-tool timeout is not a spend limit, and network reachability is not target
authorization. Use only the credentials and test data needed for this scope.

## This repository's dogfood lane

The former `.github/workflows/dogfood-review.yml` has been removed in favor of
the 0cloud GitHub App. Its pinned v0.15.0 binary, `DOGFOOD_OPENAI_API_KEY`, `$2`
ceiling and 14-day Actions artifact recipe describe the **retired workflow**,
not the current App configuration. Do not recreate or enable that workflow by
following older documentation.

The repository's `public-pr.yml` records a separate security policy: it uses
`pull_request_target` only to state the isolation requirement, without checking
out or executing fork code. That policy is specific to this repository; it
cannot protect a workflow you copy into another repository or establish the
GitHub App's deployed repository policy.

## Security considerations

| Concern | Mitigation |
| --- | --- |
| Provider key leakage | Step-scoped secrets; no privileged credentials in untrusted execution. |
| Model cost | Explicit review budget, account limits, and a whole-job timeout; inspect interrupted/partial results. |
| Contributor code and prompt injection | Trusted tool distribution plus a disposable, constrained execution environment and explicit approval policy. |
| Container privileges | Nonroot image, minimal mounts/permissions and restricted egress; no host Docker socket for untrusted work. |
| Evidence exposure | Review reports before uploading; use suitable artifact retention and repository access. |
| Incomplete review | Keep process errors, coverage limits and finding gates separate. |

## Known limitations

- The composite action `0sec-labs/0sec/.github/actions/0sec-scan` is not shipped.
  Proposed action inputs are not a supported public contract.
- Managed App enrollment and service execution depend on the account and
  deployed backend, not merely a successful browser login.
- Live target scans need runner-side reachability and authorized scope.
- `claude`, `codex` and `gemini` runtimes need their CLI subprocesses and
  authentication on the runner. `api` is the straightforward unattended path.
- A finding, a SARIF upload and a successful job are not interchangeable with
  verified exploitability or complete security coverage.

### Managed lifecycle compatibility

The `connect` / `service` commands are separate from App-triggered reviews.
Before using them for CI-managed recurrence, confirm the deployed API contract:

- The reviewed Cloud schedule-list handler returns the whole organization's
  schedules and does not filter the CLI's `?target=` query. `connect` can
  mistake another repository's schedule for the requested one, while
  `service disconnect` deletes every returned schedule. Do not use that
  disconnect path as a repository-selective operation until compatibility is
  confirmed.
- `service start --cost-ceiling` currently sends `secure_config.cost_ceiling`,
  while the reviewed server accepts `secure_config.cost_ceiling_usd`. Do not
  assume the one-shot flag enforces a managed-service budget.
- `service wait` returns terminal scan records, including failures, without
  making a failed scan itself a nonzero CLI exit. Check the returned `status`
  and `final_report`.

These findings compare public CLI `708f0117` with Cloud integration source
`61e68bad` (`website-integration-20260918`), not an authenticated production
acceptance test. The older Cloud root checkout `d2cb1a38` lacks some newer
managed integration contracts; neither checkout identifies the deployed
revision. Confirm account access and deployment with the team before dispatch.

## See also

- [Scan Workflows](/scan-workflows/) — choose the right scan mode
- [Integrations](/integrations/) — MCP, reports and containers
- [Configuration](/configuration/) — runtimes and model configuration
- [API Keys](/api-keys/) — authentication and provider choice
- [Budget Management](/budget-management/) — cost controls and interrupted runs
- [Scope & Authorization](/scope/) — explicit target policy
- [Commands](/commands/) — CLI reference and managed-service compatibility
