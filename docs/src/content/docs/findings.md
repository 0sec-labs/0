---
title: Findings
description: Review, triage and hand off findings in the browser app or from the CLI.
---

Every scan, mission and automation writes findings. Duplicates of the same issue are grouped into one family by fingerprint, so a decision on one occurrence applies to all of them.

## In the browser app

Open **Findings** in `0`.

- **Views:** **All**, **Needs review**, **Fix ready** and **Closed**. Search, filter by severity and status, and switch between list and board layout.
- **Display options:** group by status, severity, category or mission, and order by severity, last updated, last seen, title or occurrences.
- **Work state:** **Backlog**, **Todo**, **In progress**, **Blocked**, **Done** or **Cancelled**. Drag a card on the board or set it in the detail panel. A finding that needs review can only be set to **Done** or **Cancelled** until it is confirmed.
- **Detail panel:** the evidence (request, response, analysis and artifacts), severity, triage state and any fix PR.
- **Triage:** **Accept** or **Dismiss**, with an optional note. **Undo** resets the finding to not reviewed.
- **Hand off:** **Verify in a mission**, **Fix in a mission** or **Investigate in a mission**, depending on the finding's state. **Terminal command** shows the same step for the CLI.
- **Bulk actions:** select several findings to change status, **Dismiss**, **Export** or **Add to mission**.
- **Export:** **Export finding** in the detail panel, or **More actions** for the current list. Formats are JSON, Markdown, HTML, SARIF and PDF.

Each finding has a stable link at `/findings/<fingerprint>`.

## From the CLI

```bash
0 findings
0 findings --severity high --triage new
0 findings show 3f2a
0 findings accept 3f2a --note "Confirmed on staging, ticket SEC-142"
0 findings suppress 3f2a --note "Test-only endpoint"
0 findings reopen 3f2a
```

`0 findings` (same as `0 findings list`) merges every local run under `~/.0/runs/` and groups duplicates. `--all` shows raw rows instead. IDs accept a unique prefix.

| Filter | Values |
|---|---|
| `--severity` | `critical`, `high`, `medium`, `low`, `info` |
| `--status` | `discovered`, `verified`, `confirmed`, `scored`, `reported`, `fixed`, `false-positive` |
| `--triage` | `new`, `accepted`, `suppressed` |
| `--category` | An attack category |
| `--scan <scan-id>` | One run |
| `--limit <n>` | Default 50 |

`show`, `accept`, `suppress` and `reopen` act on one database. Point them at the run that holds the finding:

```bash
0 findings show 3f2a --db-path ~/.0/runs/<scan-id>/state.db
```

`0 findings show` prints the business priority and its rationale, technical severity, CVSS when present, status, triage state, the evidence and related occurrences.

## Status and triage are different

- **Status** is what the automation established: `discovered` is a candidate; `verified` and `confirmed` passed a verification step; `false-positive` was rejected.
- **Triage** is your decision: `new`, `accepted` or `suppressed` (shown as **Dismissed** in the app).

Accepting a finding does not verify it, and suppressing it does not prove it false. To get executable proof, use [`0 verify`](/verify-and-fix/).

## Teach 0 your false positives

Record why a finding is not a real issue. Later scans that read the same database recall the memory as context.

```bash
0 findings triage mark-fp 3f2a --reason "Echo endpoint only exists in test fixtures" \
  --db-path ./engagement.db
0 findings triage memory add --finding 3f2a --reason "Intentional CORS for the public API" \
  --db-path ./engagement.db
0 findings triage memory list --db-path ./engagement.db
0 findings triage memory remove MEMORY_ID --db-path ./engagement.db
```

`mark-fp` suppresses the finding and creates a memory. `memory add` creates a memory without suppressing. `--scope global|target|package` sets where a memory applies (default `target`); `--scope-value` names the target URL or package.

To reuse memories across runs, scan into the same database with `--db-path`. A new run database does not inherit them. Memories are treated as untrusted hints: the agents still check the current code and deployment.

## Limits

- A finding without reproduced evidence is a lead. Check its status and evidence before you report it.
- Fingerprint grouping can merge or split issues imperfectly. Findings without a fingerprint stay separate.
- For programmatic access from other tools, use the [Findings API](/findings-api/).
