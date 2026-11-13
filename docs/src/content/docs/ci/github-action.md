---
title: CI/CD — run 0 in your pipeline
description: Run the open-source CLI in a trusted GitHub Actions workflow with explicit credentials, artifacts and gates.
---

Run the open-source CLI on your own runner with supported model access.
You own runner configuration, credentials, cost, and output handling. No
platform account is required.

Use the reusable GitHub Action below or invoke the CLI directly on any CI/CD
runner. Both use the open-source harness and your configured model access.

## Enterprise automation

The [enterprise platform direction](/roadmap/#enterprise-platform) builds on
CLI and CI adoption with organization-wide automation and use-case integrations.
The former Zero Cloud GitHub App implementation is separate from this runner
workflow and is not a current self-serve onboarding offer. Discuss enterprise
requirements and available integrations with the
[team](https://0.security/contact/?intent=contact).

## CI and the browser

CLI, MCP, and browser workflow clients can use the same registered engine and
inspect its retained runs; see [Engine Connections](/engine-connections/).
The standalone `0 review` examples below export report artifacts. Uploading a
SARIF report to GitHub does not automatically import that run into a local
browser engine. Preserve JSON/SARIF and execution status in CI; use the owning
engine's workflow interfaces when shared run history is required.

## Reusable GitHub Action

The root `action.yml` in `0sec-labs/0` installs a checksum-verified Linux release
(or uses `cli-path`), runs an assessment, and enforces the finding threshold.
Pin both the action commit and CLI release for repeatable runs. The `main` ref
below follows development; replace it with a reviewed full commit SHA before
using it in a privileged pipeline.

```yaml
name: "0 security gate"
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - name: Review authorized source
        uses: 0sec-labs/0@main # Pin a reviewed full commit SHA.
        with:
          version: v0.28.5 # Select the reviewed CLI release.
          path: .
          runtime: api
          cost-ceiling: '5'
          severity-threshold: high
          threshold: '0'
          report-dir: 0-report
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - name: Retain reports and execution metadata
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: 0-security-report
          path: 0-report/
          retention-days: 14
```

Run this from a trusted workflow and reviewed source revision. Do not use
`pull_request_target` to check out and execute arbitrary fork code with secrets.
Model access and tool execution remain your responsibility. A cost ceiling is
an estimated model-spend limit; in-flight usage may overshoot. Configure the
job deadline separately from the per-tool timeout.

The action fails on a CLI execution error, missing/invalid report, or a findings
count above your threshold. `severity-threshold: none` disables the findings
gate while execution failures still fail. Review partial reports on failed
runs. A passing gate describes the reported findings and execution outcome;
it is not proof of exhaustive coverage.

The action retains `report.json`, `report.sarif`, `run.json`, and `0.stderr.log`
in the selected directory. `run.json` records invocation and revision metadata;
it does not import results into the browser. Keep artifacts private to the
appropriate repository audience and inspect stderr before sharing it.

The action never posts comments, opens fixes, or uploads SARIF automatically.
Add `github/codeql-action/upload-sarif` and `security-events: write` explicitly
when needed. On failed gates, use an `if: !cancelled()` upload step and check
that the SARIF file exists; install or parsing failures may leave no SARIF.

## Container-based workflow

The `ghcr.io/0sec-labs/0` image includes the CLI, Node 24, FoxGuard, pentest
and identity tooling. A job container uses shell steps; the image's normal
`docker run` entrypoint invokes the CLI directly.

This minimal example is **manually dispatched from a trusted workflow/ref**.
It is not a policy for executing arbitrary contributor code:

```yaml
# .github/workflows/0.yml
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
    container: ghcr.io/0sec-labs/0:latest
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
          name: 0-results
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
    curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
    echo "$HOME/.0/bin" >> "$GITHUB_PATH"
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

## Action inputs and outputs

| Input | Default | Purpose |
| --- | --- | --- |
| `version` | `latest` | CLI release tag; pin a reviewed release for reproducibility |
| `cli-path` | — | Use an existing executable instead of installing a release |
| `mode` | `review` | `review`, `audit`, or `scan` |
| `path` | `.` | Local source-review target |
| `package` | — | Required package identifier for `audit` |
| `target`, `scope` | — | Authorized URL and required scope file for `scan` |
| `scan-mode` | `probe` | `probe`, `deep`, `mcp`, or `web` |
| `depth` | `quick` | `quick`, `default`, or `deep` |
| `runtime` | `api` | `api`, `claude`, `codex`, `gemini`, or `auto` |
| `timeout` | `300000` | Positive per-tool timeout in milliseconds |
| `cost-ceiling` | `5` | Positive estimated model budget in USD |
| `diff-base` | — | Fetched Git base for diff-aware `review` only |
| `format` | `json` | Primary output path (`json` or `sarif`); both reports are generated |
| `severity-threshold` | `high` | `critical`, `high`, `medium`, `low`, `info`, or `none` |
| `threshold` | `0` | Allowed count at or above the severity threshold |
| `report-dir` | `0-report` | Report and execution metadata directory |

Outputs are `report-file`, `json-report-file`, `sarif-report-file`,
`total-findings`, `qualifying-findings`, `should-fail`, `execution-successful`,
`gate-message`, and
`comment-body`. The Markdown output is provided for your own review tooling;
it is not posted automatically. `should-fail` describes the findings gate;
execution errors fail independently and may occur before outputs exist.
`execution-successful` reports the absence of explicit failure/incompletion in
the report; it does not override the CLI exit status or establish coverage.
Reports from older releases without completeness fields still require review.

`scripts/run-github-action.sh` and `scripts/render-github-action-output.mjs`
implement this action. The wrapper accepts the corresponding `INPUT_*`
environment variables with hyphens replaced by underscores, plus
`GITHUB_OUTPUT` and `ZERO_ACTION_ROOT` (or `GITHUB_ACTION_PATH`). It runs the
installed `0` executable. The wrapper enforces both execution and findings
failures; the renderer alone enforces the findings gate only when
`ZERO_ACTION_ENFORCE_GATE=1` is set.

## Other CI/CD runners

Use the same installed CLI on GitLab CI, Jenkins, or another trusted runner:

```bash
0 review . --runtime api --depth quick --cost-ceiling 5 \
  --format json > report.json
```

Supply model credentials through the runner's secret store, retain the process
exit status and report even on failure, and implement your release gate against
the structured findings. Direct CLI commands do not apply this action's severity
gate automatically. Run a separate SARIF-formatted assessment only if needed;
the action wrapper generates SARIF from its JSON report without a second paid run.
Keep deployment dependent on a successful security job in your pipeline.

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
| ChatGPT Codex | `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` |

See [API Keys](/api-keys/) for provider requirements, account restrictions and
fallback order. Subscription authentication is not a promise that unattended
CI is permitted by that provider. Enterprise integrations have separate service
access; local CI tools continue running on your runner.

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

The former paid `dogfood-review.yml` is retired. Its old provider secret and
budget do not configure the current reusable action. The `ci-action.yml` lane
uses synthetic reports and a fake CLI to verify report/gate behavior without
model calls. It does not establish a successful live security assessment.

The repository's `public-pr.yml` records a separate policy: it uses
`pull_request_target` only to state the isolation requirement, without checking
out or executing fork code. That policy is specific to this repository; it
cannot protect a workflow copied into another repository.

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

- The composite action `0sec-labs/0/.github/actions/0-scan` is not shipped.
  Proposed action inputs are not a supported public contract.
- Managed App enrollment and service execution depend on account access and
  the deployed backend, not merely a provider credential.
- Live target scans need runner-side reachability and authorized scope.
- `claude`, `codex` and `gemini` runtimes need their CLI subprocesses and
  authentication on the runner. `api` is the straightforward unattended path.
- A finding, a SARIF upload and a successful job are not interchangeable with
  verified exploitability or complete security coverage.

## See also

- [Scan Workflows](/scan-workflows/) — choose the right scan mode
- [Integrations](/integrations/) — MCP, reports and containers
- [Configuration](/configuration/) — runtimes and model configuration
- [API Keys](/api-keys/) — authentication and provider choice
- [Budget Management](/budget-management/) — cost controls and interrupted runs
- [Scope & Authorization](/scope/) — explicit target policy
- [Commands](/commands/) — local CLI reference
