---
title: Verify and fix
description: Reproduce a finding, generate a patch that passes your tests, or run discovery through repair in one command.
---

A finding is a claim. Verification runs it. A fix is accepted only when the patched code no longer reproduces and your tests still pass.

| You have | Run |
|---|---|
| A repository and its test command | `0 scan repair ./my-app --test-command "npm test"` |
| One finding with executable PoC steps | `0 verify finding.json --runner docker` |
| One reproduced source finding | `0 fix ./my-app --finding finding.json --test-command "npm test"` |

In the browser app, open a finding under **Findings**. The detail panel offers **Verify in a mission**, **Fix in a mission** or **Investigate in a mission**, depending on its state, plus the equivalent terminal command under **Terminal command**.

## How scans verify findings

Scans verify before they report. On `scan web`, each candidate goes to a fresh verifier session that gets the finding's request, response and analysis, replays the attack, tries variations and marks it `confirmed` or `false-positive`. Source review and `scan deep` run skeptic or refutation passes instead. These are model judgments backed by the evidence they collected. They are not deterministic replays. See [Triage and validation](/triage/) for each gate.

The commands on this page add executable proof.

<span id="scan-repair"></span>
## Find, fix and verify a repository

```bash
0 scan repair ./my-app \
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
| `--state-dir <path>` | `~/.0/secure/<repo-hash>`, so learnings carry across runs |
| `--resume` | Continue a compatible interrupted, blocked or failed run |
| `--publish` | Push verified repairs as GitHub pull requests. Needs authenticated `gh`. Never merges or deploys. |

### Output

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

## Verify one finding

```bash
0 verify finding.json --runner docker --output verification-result.json
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

### Output

`0 verify` prints a `VerificationResult` JSON to stdout, or to `--output`:

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

See [Verification result schema](/verification-result/) for every field.

### Other verification modes

```bash
# Replay the vulnerable and patched snapshots in a reproduction bundle.
0 verify --bundle ./bundle-dir --runner docker

# Built-in fixture: run your CLI against a malicious local API.
0 verify --fixture cli-path-traversal \
  --fixture-command '["your-cli","export","--api","{{apiUrl}}","--output","{{exportDir}}"]'

# Kernel finding: generate a reproducer and confirm it in a KASAN VM.
env ZERO_KERNEL_VERIFY=1 0 verify --kernel-finding finding.json --kernel-tree ./linux
```

Bundle, fixture and kernel modes each have their own result shape and exit codes. Kernel mode needs the VM setup in [Kernel VM verification](/kernel-vm/).

## Fix one finding

```bash
0 fix ./my-app --finding finding.json \
  --verification-result verification-result.json \
  --test-command "npm test" --output fix.apply-patch
```

`fix` needs:

- a clean local Git worktree containing the affected file;
- a finding with a `verificationSpec` and a source file reference;
- proof it reproduced: a `verification_result` with status `reproduced` inside the finding, or `--verification-result`;
- a regression command.

You can select a stored finding instead with `--finding-id <id> --db-path <path>`.

0 checks that the spec reproduces on the unpatched code, then generates up to 3 candidates in an isolated worktree. A candidate passes when the spec no longer reproduces and your test command passes. `--output` writes the validated patch in apply_patch format, not a unified diff. Your worktree is untouched unless you add `--apply`.

| Exit | Meaning |
|---|---|
| `0` | Validated candidate, or applied and retested |
| `1` | Not fixed |
| `2` | Precondition failed, or error |

Specs with a `behavior` section need a running target and are rejected here. Use `scan repair` for those.

## Limits

- `not_reproduced` can mean the environment differs from the original. `skipped` and `error` are not evidence of a fix.
- `reproduced` means the declared assertions passed. Check that those assertions actually show the exploit.
- Setup commands, test commands and generated probes run as you. Disposable checkouts and worktrees are not an OS sandbox. Use a disposable machine for untrusted code.
- `costUsd` counts provider-reported usage. It can miss spend across phases or resumes. `--cost-ceiling` is checked between findings, not enforced by the provider.
- Model-backed verification inside scans is a second opinion with evidence, not independent reproduction.
