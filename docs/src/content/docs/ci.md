---
title: Pull request checks (GitHub Action)
description: Scan only what a pull request changes with the 0 Action, and show the findings in GitHub's Security tab.
---

The 0 Action scans a pull request and uploads the result to GitHub code scanning, so findings appear in the repository's **Security** tab and as annotations on the pull request. It needs no server: it installs a verified release of `0`, runs `0 scan --diff`, and uploads the SARIF file with `0 findings upload`.

```yaml
name: 0 security
on: pull_request

permissions:
  contents: read
  security-events: write   # upload to code scanning

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: 0sec-labs/0security@v0.41.0
        with:
          version: 0.41.0 # Pin the CLI
          fail-on: high
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Use the key of the provider for the model you choose (see [Models](/models/)). The default model needs `OPENAI_API_KEY`.

## What it does

1. **Installs the release you pin.** `version` is required. The installer downloads that release and refuses it unless its checksum matches the release's `checksums.txt`.
2. **Scans the change, not the repository.** On a pull request it compares with the base branch and reviews only the files that differ and the code they connect to, so a check costs a fraction of a full scan. A FoxGuard pattern scan runs first and its hits are given to the scan as leads.
3. **Uploads the findings** to code scanning with `0 findings upload`. Alerts are matched by fingerprint, so pushing again updates them instead of duplicating them.
4. **Fails the job** when a finding is at or above `fail-on`. The upload happens first, so the findings are visible either way.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `version` | required | Release of 0 to install, for example `0.41.0`. |
| `target` | `.` | Folder to scan, relative to the workspace. |
| `diff-base` | the pull request's base branch | Git ref to compare with. Outside a pull request, empty scans the whole folder. |
| `model` | the default model | Model for the scan thread. |
| `budget` | `5` | Stop at this many USD. The findings so far are kept and the job warns that they are partial. |
| `passes` | `1` | Scan this many times and merge the findings; the budget is split between them. |
| `fail-on` | none | Fail at or above this severity: `critical`, `high`, `medium`, `low` or `info`. |
| `upload` | `true` | Upload to code scanning. Needs `security-events: write`. |
| `github-token` | the job's token | Token used for the upload. |

Outputs: `sarif` (path of the file) and `exit-code` (0 done, 1 a finding at or above `fail-on` or the scan failed, 2 usage error, 3 stopped at the budget).

## Things to know

- **Same-repository pull requests only.** A pull request from a fork has no access to your secrets, so it cannot run a model. Do not work around this with `pull_request_target`: it would run a model on untrusted code with your key.
- **Use the default checkout.** On a pull request it checks out the merge commit, so comparing with the base branch gives exactly the change.
- **Code scanning needs a supported plan.** On private repositories it is part of GitHub Code Security.
- **Not a verdict.** Findings are what a model found and checked in the code; the report says what it covered. Treat a clean run as "nothing found", not "safe".

## Keep an SBOM and watch it for new advisories

An SBOM and a regular advisory check are what the EU Cyber Resilience Act expects a manufacturer to keep. A scheduled job can regenerate the SBOM from your lockfiles and fail when a component has a known advisory; the lookup uses the public OSV database.

```yaml
name: dependency advisories
on:
  schedule:
    - cron: "17 5 * * *"
  workflow_dispatch:

jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install 0
        run: |
          VERSION=0.41.0 # Pin the CLI
          RELEASE_BASE_URL="https://github.com/0sec-labs/0security/releases/download/v${VERSION}" INSTALL_DIR="$RUNNER_TEMP/0" sh <(curl -fsSL "https://raw.githubusercontent.com/0sec-labs/0security/v${VERSION}/install.sh")
          echo "$RUNNER_TEMP/0" >> "$GITHUB_PATH"
      - run: 0 sbom generate . -o sbom.cdx.json
      - run: 0 sbom check sbom.cdx.json
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: sbom, path: sbom.cdx.json }
```

`0 sbom check` exits 1 when it finds an advisory, so the job fails and you are told. This produces evidence for your own records; it does not by itself make a product compliant.
