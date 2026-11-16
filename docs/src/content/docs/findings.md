---
title: Findings
description: Review, triage, reproduce, fix, export and report findings in the browser app or from the CLI.
---


Every scan, thread and automation writes findings. Duplicates of the same issue are grouped into one family by fingerprint, so a decision on one occurrence applies to all of them.

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

Export findings without opening the browser:

```bash
0 findings list 3f2a 91bc --format sarif -o findings.sarif
0 findings list --scan <scan-id> --format pdf -o report.pdf
```

Formats are `json` (default), `md`, `sarif`, `html` and `pdf`. Without `-o` the report goes to stdout, except `pdf`, which needs a file.

`0 findings show` prints the business priority and its rationale, technical severity, CVSS when present, status, triage state, the evidence and related occurrences.

## Status and triage are different

- **Status** is what the automation established: `discovered` is a candidate; `verified` and `confirmed` passed a verification step; `false-positive` was rejected.
- **Triage** is your decision: `new`, `accepted` or `suppressed` (shown as **Dismissed** in the app).

Accepting a finding does not verify it, and suppressing it does not make it false. To reproduce it, use [`0 scan verify`](#verify-and-fix).

## Teach 0 your false positives

Record why a finding is a false alarm. Later scans that read the same database recall the memory as context.

```bash
0 findings update 3f2a --status false-positive --reason "Echo endpoint only exists in test fixtures" \
  --db-path ./engagement.db
0 memory set --add --finding 3f2a --reason "Intentional CORS for the public API" \
  --db-path ./engagement.db
0 memory list --db-path ./engagement.db
0 memory list MEMORY_ID --db-path ./engagement.db
```

`mark-fp` suppresses the finding and creates a memory. `memory add` creates a memory without suppressing. `--scope global|target|package` sets where a memory applies (default `target`); `--scope-value` names the target URL or package.

To reuse memories across runs, scan into the same database with `--db-path`. A new run database does not inherit them. Memories are treated as untrusted hints: the agents still check the current code and deployment.

## Verify and fix

A finding is a claim. Verification runs it. A fix is accepted only when the patched code no longer reproduces and your tests still pass.

| You have | Run |
|---|---|
| A repository and its test command | `0 scan ./my-app --module repair --test-command "npm test"` |
| One finding with executable PoC steps | `0 scan verify finding.json --runner docker` |
| One reproduced source finding | `0 scan fix ./my-app --finding finding.json --test-command "npm test"` |

In the browser app, open a finding under **Findings**. The detail panel offers **Verify in a thread**, **Fix in a thread** or **Investigate in a thread**, depending on its state, plus the equivalent terminal command under **Terminal command**.

### How scans verify findings

Scans verify before they report. On `scan web`, each candidate goes to a fresh verifier session that gets the finding's request, response and analysis, replays the attack, tries variations and marks it `confirmed` or `false-positive`. Source review and `scan deep` run skeptic or refutation passes instead. These are model judgments backed by the evidence they collected. They are not deterministic replays. 

The commands on this page reproduce the issue by running it.

<span id="scan-repair"></span>
### Find, fix and verify a repository

```bash
0 scan ./my-app --module repair \
  --setup-command "npm ci" \
  --test-command "npm test" \
  --cost-ceiling 10 > repair.json
```

Commit first. 0 clones the committed revision, so uncommitted edits are not part of the run. For each finding it:

1. Runs your setup and tests on a clean baseline checkout.
2. Writes a behavioral probe, with a legitimate-use control, that shows the bug.
3. Freezes the probe and asks the model for a patch, up to `--max-attempts` (default 3).
4. Marks the repair `verified` only if your tests and the frozen probe pass on a fresh patched checkout.

| Option | Default |
|---|---|
| `--test-command` | Required. Must pass before and after repair. |
| `--setup-command` | None. Runs in each disposable checkout. |
| `--source-path <dir>` | Whole repository |
| `--timeout <ms>` | `3600000` (1 hour) for the whole run |
| `--max-findings <n>` | 10 |
| `--rules <text>` | None. Plain-English repair standards, for example "minimal diffs, no new dependencies". |
| `--state-dir <path>` | `~/.0/secure/<repo-hash>`, so memory carries across runs |
| `--resume` | Continue a compatible interrupted, blocked or failed run |
| `--publish` | Push verified repairs as GitHub pull requests. Needs authenticated `gh`. Never merges or deploys. |

#### Output

`scan repair` prints one JSON document and streams progress to stderr:

```json
{
  "version": 1,
  "runId": "…",
  "status": "completed",
  "revision": "…",
  "findings": [ … ],
  "repairs": [
    {
      "findingId": "…",
      "status": "verified",
      "attempts": 1,
      "patchPath": "…/changes.diff",
      "changedFiles": ["src/routes/export.ts"],
      "baseline": { … },
      "verification": { … },
      "artifactDir": "…"
    }
  ],
  "errors": [],
  "pullRequests": [],
  "costUsd": 1.42
}
```

Each repair is `verified`, `not_reproduced`, `not_fixed`, `blocked` or `error`. Read every entry. A `completed` run can still contain blocked findings or errors.

Exit codes: `0` completed, `2` blocked, `3` failed, `130` cancelled.

The state directory keeps each finding's probe, baseline and verification results and the command logs. Without `--resume`, a run in the same state directory starts fresh and resets its managed checkout, so keep no manual edits there.

### Verify one finding

```bash
0 scan verify finding.json --runner docker --output verification-result.json
```

`finding.json` is a single finding with `pocSteps`, for example one entry from a run's `report.json`:

```bash
jq '.findings[0]' ~/.0/runs/<scan-id>/report.json > finding.json
```

| Runner | Where steps run |
|---|---|
| `local` | On your host. The default outside the workbench. |
| `docker` | In a container with networking off by default |
| `smolvm` | In a microVM. The default inside an admitted workbench. Refuses private and loopback destinations. |
| `qemu` | In an offline QEMU guest. Needs `--qemu-binary`, `--qemu-kernel` and `--qemu-busybox`. |

HTTP replay needs `--scope`. For Docker, a bridge or custom network needs `--docker-network <name>` plus `--scope`, and then only HTTP steps are allowed. `--target target.json` supplies the base URL, environment and personas.

#### Output

`0 scan verify` prints a `VerificationResult` JSON to stdout, or to `--output`:

```json
{
  "status": "reproduced",
  "mode": "deterministic_replay",
  "finding_id": "…",
  "commands": [{ "argv": ["…"], "exit_code": 0, "duration_ms": 412 }],
  "assertions": [{ "kind": "http_status", "target": "…", "expected": 200, "actual": 200, "passed": true }],
  "evidence_artifacts": [{ "kind": "…", "path": "…", "sha256": "…" }],
  "engine_metadata": { "os": "linux", "arch": "x64", "runner": "docker" }
}
```

| Exit | Status |
|---|---|
| `0` | `reproduced`: the declared assertions passed |
| `1` | `not_reproduced` |
| `2` | `skipped`, for example no `pocSteps` |
| `3` | `error`: setup or execution failed |

The result carries `status`, `mode`, `finding_id`, `commands` (argv, exit code, excerpts capped at 8 KiB), `assertions` (`file_exists`, `http_status`, `string_in_output` or `exit_code`, each with `expected`, `actual` and `passed`), `evidence_artifacts` (kind, path, SHA-256) and `engine_metadata`. Assertions are machine-checkable observations, not model confidence: with none declared there is no `reproduced` verdict, even when the exit code is zero. `agent_assisted` mode is reserved and never used as a fallback. The type is `VerificationResult` in `packages/engine/src/shared/verification.ts`; import `VerificationResultSchema` from `@0/engine/shared` to validate one. A path alone is not integrity evidence; check the hash.

#### Other verification modes

```bash
# Replay the vulnerable and patched snapshots in a reproduction bundle.
0 scan verify --bundle ./bundle-dir --runner docker

# Built-in fixture: run your CLI against a malicious local API.
0 scan verify --fixture cli-path-traversal \
  --fixture-command '["your-cli","export","--api","{{apiUrl}}","--output","{{exportDir}}"]'

# Kernel finding: generate a reproducer and confirm it in a KASAN VM.
env ZERO_KERNEL_VERIFY=1 0 scan verify --kernel-finding finding.json --kernel-tree ./linux
```

Bundle, fixture and kernel modes each have their own result shape and exit codes.

### Fix one finding

```bash
0 scan fix ./my-app --finding finding.json \
  --verification-result verification-result.json \
  --test-command "npm test" --output fix.apply-patch
```

`fix` needs:

- a clean local Git worktree containing the affected file;
- a finding with a `verificationSpec` and a source file reference;
- evidence that it reproduced: a `verification_result` with status `reproduced` inside the finding, or `--verification-result`;
- a regression command.

You can select a stored finding instead with `--finding-id <id> --db-path <path>`.

0 checks that the spec reproduces on the unpatched code, then generates up to 3 candidates in an isolated worktree. A candidate passes when the spec no longer reproduces and your test command passes. `--output` writes the validated patch in apply_patch format, not a unified diff. Your worktree is untouched unless you add `--apply`.

| Exit | Meaning |
|---|---|
| `0` | Validated candidate, or applied and retested |
| `1` | Not fixed |
| `2` | Precondition failed, or error |

Specs with a `behavior` section need a running target and are rejected here. Use `scan repair` for those.

#### Limits of verification

- `not_reproduced` can mean the environment differs from the original. `skipped` and `error` are not evidence of a fix.
- `reproduced` means the declared assertions passed. Check that those assertions actually show the exploit.
- Setup commands, test commands and generated probes run as you. Disposable checkouts and worktrees are not an OS sandbox. Use a disposable computer for untrusted code.
- `costUsd` counts provider-reported usage. It can miss spend across phases or resumes. `--cost-ceiling` is checked between findings, not enforced by the provider.
- Model-backed verification inside scans is a second opinion with evidence, not independent reproduction.


## Export and share

`scan` takes `--format terminal|json|sarif|md|html|pdf`; `0 findings list --format ... -o <file>` exports saved findings (without `-o`, output goes to stdout except `pdf`, which needs a file). `html` and `pdf` from `scan` are saved to a timestamped file in the system temp directory that you should copy somewhere durable. Every run also writes `report.json` next to its database in `~/.0/runs/<scan-id>/` (`ZERO_RUN_DIR` changes that). In the browser app, use **Export finding** or **More actions**.

A full `report.json` carries evidence, proof-of-concept steps and descriptions that can quote source code or secrets. To pass findings to someone else, write a share-safe copy:

```bash
0 findings reports export ./report.json  <!-- docs-check: allow-moved --> --output ./report.share.json
```

It keeps the target, summary and each finding's id, title, severity, category, status, fingerprint, CVSS, confidence and source location, and leaves out evidence, PoC steps, agent transcripts, triage notes, suggested code and local absolute paths. SARIF output works with `github/codeql-action/upload-sarif`. To bring a CI report into the browser app, use `0 findings list --import ./0-report/report.json --db-path <db>` (see [CI](/#ci)).

External writes, only when you ask: `0 scan <target> --export github:owner/repo` opens one issue per finding (verified or not, with `GITHUB_TOKEN` set), and `--emit pr` opens a pull request per reproduced finding and writes the unverified ones to `hypotheses.md` (`--dry-run` prints the `git` and `gh` commands instead). Confirm you are allowed to disclose before you use them.

### Draft advisories

`0 scan disclose` turns stored findings into GHSA-ready Markdown advisories and never sends anything.

```bash
0 scan disclose --db-path ./engagement.db --scan SCAN_ID --dry-run
0 scan disclose 3f2a --db-path ./engagement.db
0 scan disclose --pack finding.json --target "lodash@4.17.21" --out notification.md
0 scan disclose --track 3f2a --out record.json
```

Advisories go to `~/0/disclosures/scan-<id>/` (or `--output-dir`), one file per finding plus `INDEX.md`. Batch mode drafts findings at or above `--severity-floor` (default `medium`) and skips `discovered`, `false-positive` and suppressed ones. `--repo <path> --ref <tag>` re-checks findings against a checkout, `--drop-fixed` sets fixed ones aside, and `--reverify` re-runs each PoC against a live target (live traffic; authorized targets only). `--pack` refuses findings whose PoC did not reproduce unless you pass `--allow-unreproduced`, and `--track` records intent only.

## Benchmarks

`packages/bench/results/benchmark-ledger.json` records dated snapshots, not a live leaderboard. Its XBOW entry (benchmark suite of 104 challenges) lists a gpt-5.4 cohort that solved 93 of 95 attempted challenges as of 2026-05-06, and a union across retained artifacts of 103 of 104. Its Cybench entry lists 36 of 40 (Azure gpt-5.4, up to 3 retries, one configuration). The ledger's own `publicationQualification` note says these are historical summaries, not a current headline: the XBOW figures union successes across retained runs and both modes, so they are not single-attempt or black-box-only rates, and the raw cohort cannot be reconstructed. Compare scores only under the same benchmark fork, model, turn cap and retry protocol. The raw results and the runner are in `packages/bench`.

## Limits

- A finding without reproduced evidence is a lead. Check its status and evidence before you report it.
- Fingerprint grouping can merge or split issues imperfectly. Findings without a fingerprint stay separate.

