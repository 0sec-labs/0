---
title: CI
description: Run 0 in GitHub Actions or any CI runner, with a findings gate, SARIF and retained reports.
---

Run 0 on your own runner with your own model key. You own the runner, credentials, cost and report handling. No account is required.

## Add the action

```yaml
name: 0 security gate
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  scan:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: 0sec-labs/0@main # Pin a reviewed full commit SHA.
        with:
          version: v0.28.5 # Pin the CLI release you reviewed.
          path: .
          runtime: api
          cost-ceiling: '5'
          severity-threshold: high
          threshold: '0'
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: 0-security-report
          path: 0-report/
          retention-days: 14
```

The action installs a checksum-verified Linux release (or uses `cli-path`), runs the scan and enforces the gate. `main` follows development, so use a full commit SHA in any privileged pipeline. The action supports Linux runners only.

Run it from a trusted workflow and a reviewed revision. Never use `pull_request_target` to check out and run fork code with secrets.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `review` | What to scan: `review`, `audit` or `scan`. See below. |
| `path` | `.` | Source path (`review`). |
| `package` | none | Package identifier (`audit`, required). |
| `target` | none | Authorized URL (`scan`, required). |
| `scope` | none | [Scope](/scope/) JSON file (`scan`, required). |
| `scan-mode` | `probe` | `probe`, `deep`, `mcp` or `web` (`scan`). |
| `depth` | `quick` | `quick`, `default` or `deep`. |
| `runtime` | `api` | `api`, `claude`, `codex`, `gemini` or `auto`. Pass credentials as step `env`. |
| `timeout` | `300000` | Per-tool timeout in ms. It is not a job deadline. |
| `cost-ceiling` | `5` | Positive USD model budget. In-flight usage can overshoot. |
| `format` | `json` | Primary report, `json` or `sarif`. Both are written. |
| `severity-threshold` | `high` | Gate severity. `none` turns the findings gate off. |
| `threshold` | `0` | Findings allowed at or above that severity. |
| `report-dir` | `0-report` | Output directory. |
| `diff-base` | none | Fetched Git base revision. Review only. |
| `changed-only` | empty | Limit static leads to changed files. Empty means `true` when `diff-base` is set. Review only. |
| `static-only` | `false` | Skip AI analysis on purpose. Not allowed with `scan`. |
| `cli-path` | none | Existing executable. Empty installs a release. |
| `version` | `latest` | Release tag, such as `v0.28.5`. Pin it. |

### Modes and scan commands

The action keeps its original `mode` names. They map to the current scan commands:

| `mode` | Same as | Notes |
| --- | --- | --- |
| `review` | `0 scan source <path>` | Source code. Supports `diff-base` and `changed-only`. |
| `audit` | `0 scan package <package>` | A package. The action uses the CLI's default ecosystem (`npm`). |
| `scan` | `0 scan web --target <url> --scope <file> --mode <scan-mode>` | A live target. |

The action invokes the old command names, which the CLI still accepts and rewrites to the new ones with a notice on stderr. See [Scan code](/scan-code/) and [Scan web and APIs](/scan-web/) for the commands.

### Diff-aware review

With `diff-base`, the action checks that the base is a fetched commit, and fails with a `fetch-depth: 0` hint if not. If `diff-base...HEAD` is empty, it skips the review, sets `skipped=true` and succeeds. `changed-only` narrows static leads and prioritization. It is not a sandbox.

## Outputs and the gate

Outputs: `report-file`, `json-report-file`, `sarif-report-file`, `total-findings`, `qualifying-findings`, `should-fail`, `execution-successful`, `gate-message`, `skipped` and `comment-body`.

The step fails when:

- the findings gate trips,
- the report is missing, invalid or records incomplete execution, or
- the CLI exits nonzero. A partial report is kept but never passes.

CLI exit `3` means the AI layer was needed but could not run. Set `static-only: true` if a static-only run is what you want. `severity-threshold: none` disables only the findings gate, and execution failures still fail. A passing gate describes the reported findings. It does not prove full coverage.

`report-dir` keeps `report.json`, `report.sarif`, `run.json` (invocation and revision metadata) and `0.stderr.log`. Keep the artifact private and read stderr before sharing it. The Markdown report is also added to the job summary. The action never posts comments, opens fixes or uploads SARIF itself.

## Pull requests

Review only the diff, with no secrets exposed to fork code:

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
    # Fork PRs get no secrets.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 20
    outputs:
      comment-body: ${{ steps.zero.outputs.comment-body }}
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

- `timeout-minutes` is the job deadline. `timeout` is per tool.
- Same-repository is a minimum, not a trust policy. For forks, use a maintainer label gate, a `workflow_dispatch` on a reviewed ref, or a `workflow_run` pattern where an unprivileged job makes artifacts and a trusted workflow reads them without checking out fork code.

### Upload SARIF

Give `security-events: write` to a separate job that holds no model credentials:

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

Results show under **Security**, **Code scanning**, subject to your repository's permissions. A SARIF upload does not enforce the severity gate. Use `if: !cancelled()` and check the file exists, since install or parse failures can leave no SARIF.

### Sticky comment

Post `comment-body` from a separate job that has only `pull-requests: write`. It starts with a hidden `<!-- 0-action -->` marker so each push updates one comment. Pass the body through `env`, never shell interpolation, because it derives from model output on contributor code.

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

### Suggested fixes

When a finding carries an exact replacement for lines the pull request changed, `0sec-labs/0/suggest` posts it as one review with inline suggestion blocks. It uses the built-in `GITHUB_TOKEN` and needs no model credentials or code checkout.

```yaml
  suggest:
    needs: review
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/download-artifact@v5
        with:
          name: 0-report
          path: 0-report
      - uses: 0sec-labs/0/suggest@<pinned-commit-sha>
        with:
          report: 0-report/report.json
```

| Input | Default | Meaning |
| --- | --- | --- |
| `report` | none | Path to the action's `report.json`. Required. |
| `github-token` | `github.token` | Token with `pull-requests: write`. |
| `max-comments` | `20` | Most suggestions in one review, 1 to 50. |
| `dry-run` | `false` | `true` prints the plan and posts nothing. |

It posts only on lines in the pull request diff, against the current head, and posts nothing if the head moved. It skips suggestions it already posted. Each one is labeled proposed and not run, because nothing builds or tests the change. Report text is treated as untrusted. Fork PRs get a read-only token, so the job fails there.

## Other ways to run

### Container

The `ghcr.io/0sec-labs/0` image has the CLI, Node 24, FoxGuard and pentest tooling. It runs as `ubuntu` (UID 1000), so make mounted workspaces readable and report directories writable.

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    container: ghcr.io/0sec-labs/0:latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - run: 0 scan source . --runtime api --depth quick --cost-ceiling 5 --format sarif > results.sarif
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - if: success() && hashFiles('results.sarif') != ''
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: results.sarif
```

Pin an image digest for reproducible runs. A failed process can leave an empty or partial file, so check it before publishing.

### Binary

```yaml
- run: |
    curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
    echo "$HOME/.0/bin" >> "$GITHUB_PATH"
- run: 0 scan source . --runtime api --cost-ceiling 5 --format sarif > results.sarif
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The installer verifies release checksums. To pin, review the installer revision and set `RELEASE_BASE_URL` to a release's download URL. `main` and `releases/latest` are not pins. The binary lacks some tools the container ships.

### Source build

For a revision you trust:

```yaml
- uses: actions/setup-node@v5
  with:
    node-version: 24
- run: corepack enable && pnpm install --frozen-lockfile && pnpm build
- run: node packages/cli/dist/index.js scan source . --runtime api --format sarif > results.sarif
```

Install and build scripts run repository code, so never do this for an untrusted PR with keys available.

### GitLab, Jenkins and others

```bash
0 scan source . --runtime api --depth quick --cost-ceiling 5 --format json > report.json
```

Use your runner's secret store, keep the exit status and report on failure, and gate on the findings. Direct CLI commands do not apply the action's severity gate. Make deployment depend on this job.

### CLI flags for CI

| Flag | Purpose |
| --- | --- |
| `--diff-base <ref>` | Git base for diff-aware review. Fetch it first. |
| `--changed-only` | Limit static leads to changed files. |
| `--format sarif`, `--format json` | SARIF for code scanning, or JSON for your own gate. |
| `--depth quick` | The quick budget. |
| `--cost-ceiling <usd>` | Estimated model-cost limit. Check partial results if it is hit. |
| `--timeout <ms>` | Per-tool timeout. Set `timeout-minutes` separately. |

Package and live-target scans work the same way:

```bash
0 scan package lodash --ecosystem npm --runtime api --depth quick --format sarif > audit.sarif
0 scan web --target https://staging.example.com --scope scope.json --mode deep \
  --runtime api --format sarif --timeout 600000 > scan.sarif
```

`scan package` audits the named package, not your lockfile. Network reachability is not authorization, so write a [scope](/scope/) file first.

## Credentials

Pass the provider's key as a step-scoped secret, never as a literal. Name the runtime explicitly when several keys are present. For example, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY` or `Z_AI_API_KEY`. Azure OpenAI uses `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL` and `AZURE_OPENAI_MODEL`. ChatGPT Codex uses `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN`. See [Models and keys](/models/) for providers and fallback. Subscription sign-in does not mean the provider allows unattended CI.

`claude`, `codex` and `gemini` runtimes need their CLI and sign-in on the runner. `api` is the simplest unattended path.

## Review CI reports in the browser

Download the report artifact and import it into a workspace database:

```bash
0 reports import ./0-report/report.json --metadata ./0-report/run.json \
  --db-path /absolute/path/security-workspace.db
0 web --db-path /absolute/path/security-workspace.db
```

Stop any engine using that database before importing, then open the app. The imported run and its findings appear there. The importer only reads JSON. It runs no commands and contacts nobody. It keeps the original report, source timestamps and CLI exit code, and derives a stable identity, so re-importing the same files does nothing. Limits are 20 MiB per report, 64 KiB of metadata and 2,000 findings.

Imported findings are marked **discovered** and **unverified**. Verification claims stay in the original snapshot, and executable instructions, fix authority and resume state are not imported. A source run shows as successful only when the report says so. Older reports without completion evidence show as unknown. A SARIF upload to GitHub does not add a run to the browser.

## Limits

- Linux runners only. The action is tested locally and with a stub-CLI self-test (`.github/workflows/action-selftest.yml`), which checks wiring and not model behavior.
- Live scans need runner-side reachability and an authorized scope.
- A finding, a SARIF upload and a green job are not verified exploitability or full coverage.

## Related

- [Scan code](/scan-code/), [Scan web and APIs](/scan-web/) and [Dependencies](/dependencies/)
- [Budgets](/budgets/)
- [Scope](/scope/)
- [CLI reference](/commands/)
