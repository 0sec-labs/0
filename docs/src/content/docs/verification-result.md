---
title: Verification Results
description: Stable JSON contract emitted by deterministic replay verifiers.
---

The replay paths of `0 verify` emit the canonical `VerificationResult` from
`packages/shared/src/verification.ts`. This is separate from human triage,
research evidence envelopes, kernel-finding verification and the aggregate
reproduction-bundle result. It describes what the selected runner observed;
it does not imply that every finding in a scan was replayed.

## Result schema

```typescript
type VerificationStatus = "reproduced" | "not_reproduced" | "error" | "skipped";

interface VerificationCommand {
  argv: string[];
  exit_code: number | null;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  duration_ms: number;
}

interface VerificationAssertion {
  kind: "file_exists" | "http_status" | "string_in_output" | "exit_code";
  target: string;
  expected: string | number | boolean;
  actual: string | number | boolean | null;
  passed: boolean;
}

interface VerificationResult {
  status: VerificationStatus;
  mode: "deterministic_replay" | "agent_assisted";
  finding_id: string;
  engine_version: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  commands: VerificationCommand[];
  assertions: VerificationAssertion[];
  evidence_artifacts: Array<{
    kind: string;
    path: string;
    sha256: string;
    bytes?: number;
  }>;
  engine_metadata: { os: string; arch: string; runner: "local" | "docker" | "qemu" };
  summary?: string;
  error_reason?: string | null;
  evidence_kind?: "reproduced-poc" | "source-only" | "reproduced-memcorruption-poc";
  oast_confirmed?: boolean;
}
```

`agent_assisted` is a schema-reserved mode, not an automatic fallback promised
by the deterministic runner. Import `VerificationResultSchema` from
`@0/shared` for runtime validation. Artifact SHA-256 values are 64 hex
characters; paths alone are not integrity evidence.

## Status semantics

| Status | Meaning |
|--------|---------|
| `reproduced` | The producer's required assertions passed. Review whether those assertions actually establish the exploit. |
| `not_reproduced` | The exploit condition was not established. The general replay runner also uses this when steps run but no assertions were declared. |
| `skipped` | No replay was performed, such as a finding without `pocSteps`. |
| `error` | An execution/setup failure prevented a reliable result, such as an unsupported executable step or timeout. |

**`status` is not the finding's human triage state.** It's an automated proof signal; a maintainer can still accept, suppress, or reopen after reviewing the evidence.

The canonical statuses do **not** include `inconclusive`. The older fixture
helper uses that status internally; the CLI converts it to `skipped`. Other
verification families can legitimately use `inconclusive` in their own schemas.
Replay CLI exits are `0` reproduced, `1` not reproduced, `2` skipped and `3` error.

`evidence_kind` and `oast_confirmed` are optional provenance signals. An
out-of-band callback is different from an in-band replay assertion; absence of
these fields is not a negative verdict. A consumer must validate the producing
path and retained evidence rather than trusting user-authored JSON as proof.

## Commands

Each record captures the real command the verifier ran:

```json
{
  "argv": [
    "paperclip",
    "company",
    "export",
    "--api",
    "http://127.0.0.1:50345",
    "--output",
    "/tmp/0-verify-a1b2/export"
  ],
  "exit_code": 0,
  "stdout_excerpt": "wrote /tmp/0-verify-a1b2/escaped-marker\n",
  "stderr_excerpt": "",
  "duration_ms": 287
}
```

`argv` must point at the implementation under test. A fixture may provide servers, files, directories, and placeholders, but it must not synthesize the vulnerable behavior the finding is supposed to verify.

## Assertions

Assertions are machine-checkable observations, not model confidence scores.
The general runner evaluates each `pocSteps[].expect` and any SDK-supplied
assertions. No assertions means no reproduced verdict, even for exit code zero.

The older CLI path-traversal fixture evaluates these additional internal
predicates before the CLI converts them to the shared assertion shape:

| Kind | Purpose |
|------|---------|
| `filesystem_exists` | A marker file exists at the escaped path. |
| `filesystem_not_exists` | The marker was not written inside the selected export root. |
| `path_outside_export_root` | The escaped marker realpath is outside the export directory. |
| `path_inside_sandbox` | The escaped marker stayed inside the verifier sandbox. |
| `no_home_profile_touch` | The replay didn't write to the home directory or shell profile files. |

Deterministic code evaluates the final assertions.

## Artifacts

The current JSON contract uses `evidence_artifacts`, not an `artifacts` map.
Each descriptor has a kind, path and SHA-256; retained stream captures from the
general runner live under `<runDir>/artifacts/`. Command excerpts are capped at
8 KiB and captures at 1 MiB per stream, so a saved capture is not necessarily
unbounded output.

Choose the invocation and storage contract deliberately:

```bash
# Execute a reviewed finding's PoC on the host and retain the replay directory
0 verify ./finding.json --runner local --out ./replay --output ./verification.json

# Isolated container replay; provision the required images beforehand
0 verify ./finding.json --runner docker --out ./replay-docker
```

`local` runs shell steps on the host; a temporary working directory is **not**
an OS sandbox. Docker uses fresh restricted containers and no network by default.
Explicit networked Docker HTTP replay requires `--scope` and `--docker-network`;
arbitrary shell commands do not receive that network access. QEMU requires a
kernel and static BusyBox and runs shell steps in an offline guest.

The fixture path cleans its temporary sandbox by default. Its
`--retain-artifacts` / `--artifact-dir` flags apply **only to `--fixture`**.
For the general replay runner use `--out`; use `--output` for the result JSON.

## CLI path traversal example

The `cli-path-traversal` fixture starts a malicious local API, creates a sandboxed export directory, and runs the real CLI argv from `--fixture-command`.

```bash
0 verify --fixture cli-path-traversal \
  --fixture-command '["paperclip","company","export","--api","{{apiUrl}}","--output","{{exportDir}}"]' \
  --retain-artifacts
```

Historical fixture-helper example (engine `0.7.13`, 2026-05-06), retained below
as an example of the **legacy internal fixture shape**, not a new run or the
current CLI schema. The CLI now adds duration/engine metadata, converts
assertions and hashes surviving fixture files into `evidence_artifacts`.

```json
{
  "status": "reproduced",
  "mode": "deterministic_replay",
  "finding_id": "fixture:cli-path-traversal",
  "engine_version": "0.7.13",
  "started_at": "2026-05-06T07:23:02.223Z",
  "completed_at": "2026-05-06T07:23:02.510Z",
  "commands": [
    {
      "argv": [
        "paperclip",
        "company",
        "export",
        "--api",
        "http://127.0.0.1:50345",
        "--output",
        "/tmp/0-verify-a1b2/export"
      ],
      "exit_code": 0,
      "stdout_excerpt": "wrote /tmp/0-verify-a1b2/escaped-marker\n",
      "stderr_excerpt": ""
    }
  ],
  "assertions": [
    {
      "kind": "filesystem_exists",
      "passed": true,
      "detail": "escaped marker exists at /tmp/0-verify-a1b2/escaped-marker"
    },
    {
      "kind": "path_outside_export_root",
      "passed": true,
      "detail": "escaped marker realpath /tmp/0-verify-a1b2/escaped-marker is outside export root /tmp/0-verify-a1b2/export"
    },
    {
      "kind": "path_inside_sandbox",
      "passed": true,
      "detail": "escaped marker stayed inside sandbox /tmp/0-verify-a1b2"
    }
  ],
  "artifacts": {
    "sandbox_ref": "/tmp/0-verify-a1b2",
    "harness_ref": "/tmp/0-verify-a1b2/harness/harness.json",
    "stdout_ref": "/tmp/0-verify-a1b2/stdout.log",
    "stderr_ref": "/tmp/0-verify-a1b2/stderr.log",
    "export_ref": "/tmp/0-verify-a1b2/export"
  },
  "summary": "CLI path traversal replay wrote a marker outside the selected export directory inside the sandbox.",
  "error_reason": null
}
```

## Cloud ingestion

Consumers can validate and store the canonical shared result and retained
artifacts. Scheduling, authorization, storage access and promotion policy belong
to the integrating service; emitting JSON locally does not upload or publish it.