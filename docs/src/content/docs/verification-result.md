---
title: Verification result schema
description: The JSON that deterministic replay verifiers emit.
---

`0 scan verify` replay paths write a `VerificationResult`, defined in `packages/engine/src/shared/verification.ts`. It records what the selected runner observed. It does not mean every finding in a scan was replayed, and it is separate from triage state and kernel-finding verification.

## Run a replay

```bash
# Run a reviewed finding's PoC on the host and keep the replay directory
0 scan verify ./finding.json --runner local --out ./replay --output ./verification.json

# Isolated container replay; provision the images first
0 scan verify ./finding.json --runner docker --out ./replay-docker
```

`--out` is the replay directory. `--output` is the result JSON.

- `local` runs shell steps on the host. A temporary working directory is not an OS sandbox.
- `docker` uses fresh restricted containers with no network. Networked HTTP replay needs `--scope` and `--docker-network`. Shell commands never get that network.
- `qemu` needs a kernel and static BusyBox and runs shell steps in an offline guest.

Exit codes: `0` reproduced, `1` not reproduced, `2` skipped, `3` error.

## Schema

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

`agent_assisted` is reserved. The deterministic runner never falls back to it. Import `VerificationResultSchema` from `@0/engine/shared` to validate a result at runtime.

## Status

| Status | Meaning |
|--------|---------|
| `reproduced` | The producer's required assertions passed. Check that they establish the exploit. |
| `not_reproduced` | The exploit condition was not established. Also used when steps ran but no assertions were declared. |
| `skipped` | No replay ran, for example a finding without `pocSteps`. |
| `error` | A setup or execution failure, such as an unsupported step or a timeout, prevented a result. |

`status` is an automated proof signal, not the finding's triage state. A maintainer can still accept, suppress or reopen the finding after reading the evidence.

`inconclusive` is not a canonical status. The CLI converts it to `skipped`.

`evidence_kind` and `oast_confirmed` are optional provenance. An out-of-band callback differs from an in-band assertion, and a missing field is not a negative verdict. Validate the producing path and the retained evidence. Do not treat user-written JSON as proof.

## Commands

Each entry records a command the verifier ran:

```json
{
  "argv": ["paperclip", "company", "export", "--api", "http://127.0.0.1:50345", "--output", "/tmp/0-verify-a1b2/export"],
  "exit_code": 0,
  "stdout_excerpt": "wrote /tmp/0-verify-a1b2/escaped-marker\n",
  "stderr_excerpt": "",
  "duration_ms": 287
}
```

`argv` must run the implementation under test. A fixture can provide servers, files and placeholders. It must not fake the vulnerable behavior.

## Assertions

Assertions are machine-checkable observations, not model confidence. The runner evaluates each `pocSteps[].expect` and any SDK-supplied assertions. With no assertions there is no `reproduced` verdict, even when the exit code is zero.

## Artifacts

`evidence_artifacts` lists each retained file with its kind, path and SHA-256. The general runner keeps stream captures under `<runDir>/artifacts/`. Command excerpts are capped at 8 KiB and captures at 1 MiB per stream. A path alone is not integrity evidence. Check the hash.

## Fixture example

The `cli-path-traversal` fixture starts a malicious local API, creates a sandboxed export directory and runs the argv you pass in `--fixture-command`.

```bash
0 scan verify --fixture cli-path-traversal \
  --fixture-command '["paperclip","company","export","--api","{{apiUrl}}","--output","{{exportDir}}"]' \
  --retain-artifacts
```

`--retain-artifacts` and `--artifact-dir` apply only to `--fixture`. The fixture cleans its temporary sandbox by default.

## Consuming results

The result and its artifacts are local files. Validate the JSON against the schema before you store it. Emitting it uploads nothing. Scheduling, authorization and storage are up to your tooling.

Next: [Verify and fix](/verify-and-fix/), [Findings](/findings/).
