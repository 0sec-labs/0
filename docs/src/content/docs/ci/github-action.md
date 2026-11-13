---
title: GitHub CI — run 0 in CI
description: Run the open-source CLI in a trusted GitHub Actions workflow with explicit credentials, artifacts and gates.
---

Run the open-source CLI on your own runner with supported model access.
You own runner configuration, credentials, cost, and output handling. No
platform account is required.

This repository ships a composite action (`action.yml` at the repository
root) that installs a checksum-verified release, runs `0 review`, `0 audit` or
`0 scan`, retains JSON/SARIF, and enforces a findings gate. You can also invoke
the CLI directly, as in the examples below.

```yaml
- uses: 0sec-labs/0@<pinned-commit-sha>
  with:
    version: v0.28.5
    diff-base: ${{ github.event.pull_request.base.sha }}
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Pin the action to a reviewed commit SHA and `version` to a release tag. The
action runs on Linux runners only.

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
        run: 0 scan source . --runtime api --depth quick --cost-ceiling 5 --format sarif > results.sarif
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
  run: 0 scan source . --runtime api --cost-ceiling 5 --format sarif > results.sarif
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

## Composite action

### Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `mode` | `review` | `review`, `audit` or `scan` |
| `path` | `.` | Review path |
| `package` | — | Package identifier (required for `audit`) |
| `target` | — | Authorized URL (required for `scan`) |
| `scope` | — | Scope JSON file (required for `scan`) |
| `scan-mode` | `probe` | `probe`, `deep`, `mcp`, `web` |
| `depth` | `quick` | `quick`, `default`, `deep` |
| `runtime` | `api` | `api`, `claude`, `codex`, `gemini`, `auto`; supply credentials as step `env` |
| `timeout` | `300000` | Per-tool timeout in ms; not a job deadline |
| `cost-ceiling` | `5` | Positive USD model budget; in-flight usage can overshoot |
| `format` | `json` | Primary report: `json` or `sarif` (both are written) |
| `severity-threshold` | `high` | Gate severity; `none` disables the findings gate |
| `threshold` | `0` | Allowed findings at or above the severity |
| `report-dir` | `0-report` | Output directory (`report.json`, `report.sarif`, `run.json`, `0.stderr.log`) |
| `diff-base` | — | Fetched Git base revision; review only |
| `changed-only` | empty | Restrict static leads to changed files. Empty means `true` when `diff-base` is set. Review only; requires `diff-base` |
| `cli-path` | — | Existing executable; empty installs a release |
| `version` | `latest` | Release tag such as `v0.28.5`; pin it |

With `diff-base`, the action first checks that the base resolves to a fetched
commit and fails with a `fetch-depth: 0` hint otherwise. If `diff-base...HEAD`
is empty, it skips the review, sets `skipped=true` and reports success.
`changed-only` narrows static-scanner leads and prioritization; it is not a
sandbox.

### Outputs

`report-file`, `json-report-file`, `sarif-report-file`, `total-findings`,
`qualifying-findings`, `should-fail`, `execution-successful`, `gate-message`,
`skipped` and `comment-body`.

The step itself fails when the findings gate trips, when the report records
incomplete execution, or when the CLI exits nonzero (a partial report is kept
but never passes). The rendered Markdown is also appended to the job summary
(`$GITHUB_STEP_SUMMARY`). The action never posts a PR comment: it has no
`pull-requests: write` need, so the step that runs the model and processes
contributor-influenced text stays read-only.

### Safe pull-request workflow

```yaml
name: 0 review
on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: 0-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Fork PRs get no secrets; do not run model credentials on fork code.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false
      - id: zero
        uses: 0sec-labs/0@<pinned-commit-sha>
        with:
          version: v0.28.5
          diff-base: ${{ github.event.pull_request.base.sha }}
          cost-ceiling: '5'
          format: sarif
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - if: always() && hashFiles('0-report/**') != ''
        uses: actions/upload-artifact@v7
        with:
          name: 0-report
          path: 0-report
          retention-days: 14
```

Notes:

- `timeout-minutes` is the whole-job deadline; `timeout` is per tool.
- The default cost ceiling is `5` USD; set it deliberately.
- Same-repository is a minimum condition, not a complete trust policy. For
  fork PRs, never expose secrets to their code. Use a maintainer label gate or
  `workflow_dispatch` against a reviewed ref, or a `workflow_run` pattern in
  which an unprivileged `pull_request` job produces artifacts and a separate
  trusted workflow consumes them without checking out fork code.
- Never use `pull_request_target` to check out and run fork code with secrets.

### SARIF upload

Add this job (or step) only for non-fork PRs; it needs
`security-events: write`, which fork PR tokens do not have. Keep that
permission on this job only, separate from the job holding model credentials:

```yaml
  upload:
    needs: review
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/download-artifact@v5
        with:
          name: 0-report
          path: 0-report
      - uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: 0-report/report.sarif
```

### Sticky PR comment (optional)

Post the `comment-body` output from a separate step with only
`pull-requests: write`. The body starts with a hidden `<!-- 0-action -->`
marker used to update one comment instead of adding a new one each push.
Pass the body through `env`, never through shell interpolation. Report text is
derived from model output on contributor code, so treat it as untrusted:

```yaml
  comment:
    needs: review
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/github-script@v8
        env:
          BODY: ${{ needs.review.outputs.comment-body }}
        with:
          script: |
            const marker = '<!-- 0-action -->';
            const body = process.env.BODY;
            if (!body) return;
            const {owner, repo} = context.repo;
            const issue_number = context.issue.number;
            const comments = await github.paginate(github.rest.issues.listComments, {owner, repo, issue_number});
            const existing = comments.find(c => c.body?.includes(marker));
            if (existing) await github.rest.issues.updateComment({owner, repo, comment_id: existing.id, body});
            else await github.rest.issues.createComment({owner, repo, issue_number, body});
```

This requires the `review` job to expose `comment-body` under `jobs.review.outputs`
(for example `comment-body: ${{ steps.zero.outputs.comment-body }}`). It also
runs only where the token can write, so it is not available on fork PRs.

### Self-test

`.github/workflows/action-selftest.yml` runs the action's unit tests and the
action itself against this repository with a stub CLI, a read-only token and no
model credentials. It verifies wiring, not model behavior.

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
CI is permitted by that provider. Managed App reviews have separate service
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
    0 scan source . \
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
  run: 0 scan package lodash --ecosystem npm --runtime api --depth quick --format sarif > audit-results.sarif
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
    0 scan https://staging.example.com \
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

- The action supports Linux runners only and has been exercised locally and
  through a stub-CLI self-test; it has not been validated against a published
  release in a live pull request here. Treat its input names as stable only
  once you pin a released version.
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
