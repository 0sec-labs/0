---
title: Reports and disclosure
description: Export findings as JSON, SARIF, Markdown, HTML or PDF, build assessment reports, and draft advisories.
---

Choose an output format on the scan, export from the browser app, or draft a disclosure from stored findings.

```bash
0 scan source ./my-app --format sarif > results.sarif
```

## Output formats

`scan web`, `scan source` and `scan package` take `--format`:

| Format | Where it goes | Use it for |
|---|---|---|
| `terminal` (default) | stdout | Reading in a terminal |
| `json` | stdout | Scripts and archives. Full report: `target`, `summary`, `findings`, `warnings`. |
| `sarif` | stdout | GitHub code scanning and other SARIF tools |
| `md` | stdout | Tickets, wikis, pull request comments |
| `html` | A file in the system temp directory | A standalone page to share |
| `pdf` | A file in the system temp directory | A printable report |

```bash
0 scan web --target https://staging.example.com --format json > scan.json
0 scan source ./my-app --format md > review.md
0 scan web --target https://staging.example.com --format html
```

HTML and PDF print `Report saved to: <path>`, a timestamped file such as `0-report-1731577200000.html` in the system temp directory, and try to open it. There is no flag to choose that path, and redirecting stdout does not move it. Copy the file somewhere durable.

Every run also writes `report.json` next to its database in `~/.0/runs/<scan-id>/`. Set `ZERO_RUN_DIR` to choose that directory.

### SARIF in GitHub

The SARIF output works with `github/codeql-action/upload-sarif`. The [GitHub Action](/ci/github-action/) produces and uploads it for you.

### Export from the browser app

Under **Findings**, use **Export finding** on one finding, or **More actions** for the current list. Formats are JSON, Markdown, HTML, SARIF and PDF.

## Assessment reports

Group several runs into one handoff report in the browser app.

1. Open **Findings**, then **More actions** > **Assessment reports**.
2. Enter a report name and choose **Create report**.
3. Choose **Edit**. Fill in **Objective and scope** and **Handoff notes**, and tick the runs under **Included scans** (up to 100). **Add a scan by ID** adds older runs.
4. Choose **Save report**, then **Export** as JSON or Markdown.

Findings with the same fingerprint are combined, and each keeps its source run, finding ID and evidence. Reports are stored in the engine's workspace. Exporting does not send anything anywhere.

The same reports are available over the engine API:

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/engagements` | List reports |
| `POST` | `/api/engagements` | Create one with `name`, optional `description`, `scanIds` and `notes` |
| `GET` | `/api/engagements/:id` | Report metadata |
| `PATCH` | `/api/engagements/:id` | Update it |
| `GET` | `/api/engagements/:id/report` | Versioned JSON report |
| `GET` | `/api/engagements/:id/report?format=markdown` | Markdown report |

Authenticate with the engine's bearer token. See [Remote engines and teams](/engines/).

## Import a CI report

Bring a report from CI into the browser app without re-running anything:

```bash
0 reports import ./0-report/report.json --metadata ./0-report/run.json --db-path ~/.0/0.db
```

`--db-path` is the browser engine's database; `~/.0/0.db` is the local default. Stop `0 web` before importing. The GitHub Action writes `report.json` and `run.json` to its report directory (`0-report` by default); `--metadata` is optional. Importing executes nothing from the report.

## Send findings to GitHub

```bash
export GITHUB_TOKEN=...
0 scan web --target https://staging.example.com --export github:your-org/security-findings
```

`--export github:owner/repo` opens one issue per finding with labels `0`, `severity:<level>` and `category:<name>`. It creates missing labels and skips an open issue with the same title. It exports every finding in the report, verified or not.

```bash
0 scan source ./my-app --emit pr --dry-run
```

`--emit pr` opens a GitHub pull request per reproduced finding and writes the unverified ones to `hypotheses.md`. `--base` sets the base branch (default `main`). `--dry-run` prints the `git` and `gh` commands instead; on `scan source` it turns on automatically when `gh auth status` fails. The scan itself still runs and spends.

## Draft advisories

`0 disclose` turns stored findings into GHSA-ready Markdown advisories. It never sends anything.

```bash
# Preview, then write
0 disclose --db-path ./engagement.db --scan SCAN_ID --dry-run
0 disclose --db-path ./engagement.db --scan SCAN_ID

# One finding
0 disclose 3f2a --db-path ./engagement.db
```

Advisories go to `~/0/disclosures/scan-<id>/` (or `--output-dir`), one Markdown file per finding plus `INDEX.md`. Batch mode drafts findings at or above `--severity-floor` (default `medium`) and skips findings that are still `discovered`, marked `false-positive` or suppressed. Name a finding ID to draft it anyway.

To check that findings still apply before you file:

| Option | What it does |
|---|---|
| `--repo <path> --ref <tag>` | Re-check each finding against a checkout of the target |
| `--drop-fixed` | Move fixed findings to `_dropped/` with a reason file |
| `--reverify --target-url <url> --scope-allowlist <hosts>` | Re-run each finding's PoC steps against a live target. Out-of-scope steps fail closed. Default 2 requests per second per host. |

`--reverify` sends real traffic. Use it only on a target you are authorized to test.

### Notification drafts, manifests and tracking

```bash
# Vendor notification draft with a "DRAFT — NOT SENT" banner
0 disclose evidence-pack finding.json --target "lodash@4.17.21" --out notification.md

# Deterministic, redacted reproducibility manifest for a verified finding
0 disclose review finding.json --target "lodash@4.17.21" --out manifest.json

# Track the disclosure timeline
0 disclose track 3f2a --out record.json
0 disclose track 3f2a --record record.json --to sent --disclosed-to "Vendor PSIRT" --out record.json
0 disclose track 3f2a --record record.json --to cve_assigned --cve-id CVE-2026-12345 --out record.json
```

`evidence-pack` refuses findings whose PoC did not reproduce unless you pass `--allow-unreproduced`. `review` fails if the finding lacks the evidence a manifest needs. `track` records intent only: statuses are `draft`, `sent`, `acknowledged`, `accepted`, `cve_assigned`, `published`, `rejected`, `not_applicable`, `duplicate` and `withdrawn`. Moving a record to `sent` does not send anything.

For HackerOne program scope, see [Specialist research](/research-workflows/#hackerone).

## Limits

- A report shows the evidence the workflow collected. Source and package findings often have no HTTP request and response, and a formatted report does not add missing proof.
- An empty report or a completed run does not prove full coverage.
- GitHub export, PR emission and `--publish` on `scan repair` are external writes. Confirm you are allowed to disclose before you use them.
