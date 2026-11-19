---
title: Findings
description: Review, triage, verify and export findings in the browser app or from the CLI.
---


Every thread and Sentinel can record findings. Duplicates of the same issue are grouped into one family by fingerprint, so a decision on one occurrence applies to all of them.

## In the browser app

Open **Findings** in `0`.

- **Views:** **All**, **Needs review**, **Fix ready** and **Closed**. Search, and filter by severity and status.
- **Work state:** **Backlog**, **Todo**, **In progress**, **Blocked**, **Done** or **Cancelled**, set in the detail panel. **Needs your review** and **Agent review** are set by 0. A finding that needs review can only be moved to **Done**, **Cancelled** or **Accepted** until it is confirmed.
- **Detail panel:** the evidence (request, response, analysis and artifacts), severity, triage state and any fix PR.
- **Triage:** **Accept** or **Dismiss**, with an optional note. **Undo** resets the finding to not reviewed.
- **Hand off:** **Verify in a thread**, **Fix in a thread** or **Investigate in a thread**, depending on the finding's state. **Terminal command** shows the same step for the CLI.
- **Bulk actions:** select several findings to change status, **Dismiss**, **Export** or **Add to thread**.
- **Export:** **Export finding** in the detail panel, or **More actions** for the current list. Formats are JSON, Markdown, HTML, SARIF and PDF.

Each finding has a stable link at `/findings/<fingerprint>`.

## From the CLI

```bash
0 findings
0 findings --severity high --triage new
0 findings show 3f2a
0 findings update 3f2a --status accepted --note "Confirmed on staging, ticket SEC-142"
0 findings update 3f2a --status suppressed --note "Test-only endpoint"
0 findings update 3f2a --status open
```

`0 findings` (same as `0 findings list`) reads the local findings database and groups duplicates. `--all` shows raw rows instead. IDs accept a unique prefix.

| Filter | Values |
|---|---|
| `--severity` | `critical`, `high`, `medium`, `low`, `info` |
| `--status` | `discovered`, `verified`, `confirmed`, `scored`, `reported`, `fixed`, `false-positive` |
| `--triage` | `new`, `accepted`, `suppressed` |
| `--category` | An attack category |
| `--limit <n>` | Default 50 |

`show` and `update` act on one database. Point them at a different one with `--db-path`:

```bash
0 findings show 3f2a --db-path ./engagement.db
```

## Scan a folder

```bash
0 scan ./your-repo
0 scan https://github.com/acme/app --budget 2 --format json -o scan.json
0 scan ./your-repo --format sarif -o scan.sarif --fail-on high
```

A scan is a thread that follows the `scan` skill: it lists every entry point of the code, checks each one, and records what it can show from the code. It appears in `0 threads` and its findings in `0 findings`, under the thread's ID. The target is a folder or a git URL (cloned shallow, then removed). A scan must not edit the code it reads: if the target is a git work tree and the scan changed a file, the scan is reported as failed and names the files. Package names and container images are not scanned.

| Option | What it does |
|---|---|
| `--budget <usd>` | Stop when the estimated spend reaches this much (default 5). Findings so far are kept. |
| `--format <format>` | `md` (default), `json`, `sarif`, `html` or `pdf`. `pdf` needs `-o`. |
| `-o, --output <file>` | Write the report to a file instead of stdout. |
| `--fail-on <severity>` | Exit 1 when a finding is at or above this severity. |
| `--timeout <seconds>` | Cancel the scan after this long (default 3600) and still print what was found. |
| `--model <model>` | Model for the scan (default `gpt-6-luna`). |

Exit codes: `0` done, `1` a finding at or above `--fail-on` or the scan failed, `2` usage error, `3` stopped at the budget or the time limit (the report is partial).

`0 scan` uses the console that is running, or the engine named by `--engine-url` or `--computer`. With none running it starts one for the scan and stops it afterwards. The scan needs a model with working tool calls: in one test a small model sent most `finding` calls without their title and evidence and took minutes. Results also vary a little from run to run, so a clean scan is not proof there is nothing to find.

The JSON report has `schemaVersion: 1`, the scan's `status` (`complete`, `budget_exhausted`, `timed_out` or `failed`), `counts` by severity, the model's closing `summary`, and for each finding its `fingerprint`, `severity`, `category`, `location`, `evidence`, `cvssScore` when given and `suggestedFix` when it wrote one. The `fingerprint` is the same for the same flaw in unchanged code, so use it to match findings between scans. The same report, in any format, is available later with `0 findings export --scan <thread id>`.

Export findings without opening the browser:

```bash
0 findings list 3f2a 91bc --format sarif -o findings.sarif
0 findings list --format md -o report.md
```

Formats are `json`, `md` and `sarif`. Without `-o` the report goes to stdout. The browser app also exports HTML and PDF.

`0 findings show` prints the business priority and its rationale, technical severity, CVSS when present, status, triage state, the evidence and related occurrences.

## Status and triage are different

- **Status** is what the automation established: `discovered` is a candidate; `verified` and `confirmed` passed a verification step; `false-positive` was rejected.
- **Triage** is your decision: `new`, `accepted` or `suppressed` (shown as **Dismissed** in the app).

Accepting a finding does not verify it, and suppressing it does not make it false. Whether a finding is verified is decided by the verifier gate (see [Verified and Not verified](#verified-and-not-verified)).

## Teach 0 your false positives

Record why a finding is a false alarm. It becomes a note in [Memory](/threads/#memory) tagged `avoid`, and later threads can read the `avoid` notes as untrusted context.

```bash
0 findings update 3f2a --status false-positive --reason "Echo endpoint only exists in test fixtures" \
  --db-path ./engagement.db
0 memory add "The public API allows CORS on purpose" --kind avoid --global
0 memory list
```

`findings update --status false-positive` suppresses the finding and remembers why. `0 memory add` remembers a note without touching any finding. Notes are untrusted hints: the agents still check the current code and deployment.

## Verified and Not verified

A finding is a claim. **Verified** means 0 ran a check itself and it passed: the check runs in a container on a copy of your changes, with the network off, after the Agent says it is done. The Agent cannot mark anything Verified. A fix shows one line under it:

```
Verified by: zizmor passed, 4 findings to 0 (14.2s)
Not verified: no container runtime is available
Not verified: zizmor failed (detector did not run)
```

- Without Docker or podman the result is **Not verified**, never Verified.
- `0 threads send new "Harden the workflows" --folder . --skill workflow-hardening --wait` runs zizmor with the repository's own configuration and actionlint after the Agent finishes. A planted unpinned action must be flagged first, so a configuration that turns the detector off reads as Not verified.
- A model's own judgment that a finding is real is not a run check. Imported findings are marked **discovered** and **unverified**.

In the browser app, open a finding under **Findings**. The detail panel offers **Verify in a thread**, **Fix in a thread** or **Investigate in a thread**, depending on its state, plus the equivalent terminal command under **Terminal command**.

## Export and share

`0 findings list --format json|md|sarif -o <file>` exports saved findings (without `-o`, output goes to stdout). In the browser app, use **Export finding** or **More actions**.

A full report carries evidence, proof-of-concept steps and descriptions that can quote source code or secrets. Check it before you pass it to someone else. To bring a report into the browser app, use `0 findings list --import ./report.json --db-path <db>`. Imported findings are marked **discovered** and **unverified**.

## Limits

- A finding without reproduced evidence is a lead. Check its status and evidence before you report it.
- Fingerprint grouping can merge or split issues imperfectly. Findings without a fingerprint stay separate.

