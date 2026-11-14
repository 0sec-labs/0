---
title: Scan code
description: Review a source repository, a pull request diff or a published package for vulnerabilities.
---

Point 0 at a repository or package. It runs a static pass, then model-driven review agents that trace each lead to a source location.

```bash
0 scan source ./my-app
```

You need a connected model ([Models and keys](/models/)). Source review does not need a scope file. It can still install dependencies, clone repositories and run tools, so review untrusted code on a disposable machine.

## Pick a command

| Target | Command |
|---|---|
| Local repository or Git URL | `0 scan source ./my-app` |
| Only what changed in a branch | `0 scan source ./my-app --diff-base origin/main --changed-only` |
| Published package (npm, PyPI, Cargo, OCI) | `0 scan package express` |
| Multi-lens sweep that emits leads | `0 scan deep ./my-app` |
| Find, reproduce, fix and verify in one run | `0 scan repair ./my-app --test-command "npm test"` (see [Verify and fix](/verify-and-fix/#scan-repair)) |

`0 scan <target>` picks the module for you. A local path, `source:<path>`, a `.git` URL, `git@…` or a `https://github.com/…` URL runs `scan source --depth deep`. `npm:`, `pypi:`, `cargo:` and `oci:` prefixes run `scan package`. Bare package names are rejected as ambiguous.

```bash
0 scan https://github.com/your-org/your-repo
0 scan pypi:requests
```

## Source review

```bash
0 scan source ./my-app --depth deep --cost-ceiling 5
0 scan source https://github.com/your-org/your-repo --format json > review.json
```

| Option | What it does |
|---|---|
| `--depth quick\|default\|deep` | Investigation budget. Default `default`. Not a wall-clock deadline. |
| `--cost-ceiling <usd>` | Stop when estimated model spend passes this. Partial findings are kept. |
| `--format terminal\|json\|md\|html\|sarif\|pdf` | Output format. See [Reports](/reports/). |
| `--runtime auto\|api\|claude\|codex\|gemini\|ollama` | Model runtime. Default `auto`. |
| `--profile <name>` | Review profile, for example `c-library`, `linux-kernel`, `evm-onchain`, `solana-onchain`, `move-onchain`, `cairo-onchain`. Default `default` (web, JS/TS, Python). |
| `--hypothesis <text>` | Seed the agents with a direction to investigate. |
| `--prior-findings <path>` | JSON array of earlier findings. Treated as untrusted context; the review looks for variants. |
| `--static-only` | Run only the static layer, on purpose. |
| `--db-path <path>` | Write to this SQLite database instead of a new run directory. |

Run `0 scan source --help` for the full list.

### Review a pull request diff

```bash
0 scan source . --diff-base origin/main --changed-only --format sarif > results.sarif
```

`--diff-base` reviews against a Git ref. `--changed-only` restricts static leads and prioritization to changed files. It is not a whole-repository result. In CI, use the [GitHub Action](/ci/github-action/).

### Hunt variants of a known fix

```bash
# List structurally similar code paths as JSON. No model or network calls.
0 scan source ./my-app --fix-commit 1a2b3c4 --variants-only

# Feed those candidates into a full review.
0 scan source ./my-app --fix-commit 1a2b3c4
```

`--fix-commit` needs a local Git repository. For a fix diff against a large tree such as the Linux kernel, use [`0 research hunt`](/research-workflows/#variant-hunting).

### C and C++ libraries

```bash
0 scan source ./libfoo --profile c-library --depth deep
```

The `c-library` profile asks the agent to build a libFuzzer harness with ASan and UBSan around a reachable entry point. `--harness-tier 2` builds a multi-component harness; `--harness-tier 3` adds QEMU sanitizer validation and needs a kernel and disk image (`--harness-qemu-kernel`, `--harness-qemu-disk`). Good evidence is the harness source, the build and run commands, the crashing input and the sanitizer output. A static-only memory-safety claim is a lead.

### Private review checks

Add your own review criteria per project. They stay on your machine under `~/.0/review-checks`.

```bash
0 checks propose --project ./my-app --name "Tenant boundary" \
  --prompt "Tenant-owned queries must use the authenticated organization."
0 checks list --project ./my-app
0 checks enable <check-id> --project ./my-app --yes
0 scan source ./my-app
```

A project can enable up to 8 checks, each up to 2,000 characters. Prompts are used literally. Each enabled check reports `pass`, `issue` or `unknown` with a reason in every output format. Checks do not change severities or exit codes. `checks set` revises a prompt, `checks disable` keeps its history, `checks remove` deletes it. Clones and downloaded packages do not inherit local approvals.

## Package scan

```bash
0 scan package express --package-version 4.18.2
0 scan package requests --ecosystem pypi
0 scan package serde --ecosystem cargo
0 scan package alpine:3.20 --ecosystem oci
```

0 downloads the package into a temporary directory, checks it against [OSV](https://osv.dev) advisories (not for OCI images), runs the static pass and reviews the code with a model. `--ecosystem` defaults to `npm`; `--package-version` defaults to the latest version.

To review a package's source with the full source-review options, use `0 scan source <name> --ecosystem npm`.

For the dependencies of your own project, use [`0 deps scan`](/dependencies/).

## Deep sweep

```bash
0 scan deep ./my-app --max-candidates 8 --cost-ceiling 5
0 scan deep ./contracts --profile evm-onchain
```

`scan deep` picks the largest candidate files, runs specialist finder lenses on each, then asks a set of verify lenses to refute every survivor. Survivors that reach the quorum are leads to verify, not confirmed bugs. It is a separate research command, not `scan source --depth deep`.

| Option | Default |
|---|---|
| `--max-candidates <n>` | 8 |
| `--models <a,b>` | One provider model. Each extra model multiplies the finder runs. |
| `--attempts <n>` | 1 per candidate, lens and model |
| `--quorum <n>` | Majority of the verify lenses |
| `--profile` | Generic lenses, or `evm-onchain`, `solana-onchain`, `cardano-onchain`, `cairo-onchain`, `move-onchain` |
| `--output <path>` | Write the result JSON to a file instead of stdout |

Exit codes: `0` sweep completed (with or without leads), `2` skipped (no files, or over the 5,000-file cap), `3` error.

## What you get

The terminal shows each finding with severity, category and evidence. `--format json` emits the full report:

```json
{
  "target": "./my-app",
  "scanDepth": "default",
  "summary": { "totalFindings": 2, "critical": 0, "high": 1, "medium": 1, "low": 0, "info": 0 },
  "findings": [
    {
      "id": "…",
      "title": "…",
      "severity": "high",
      "category": "…",
      "status": "discovered",
      "evidence": { "request": "…", "response": "…", "analysis": "…" }
    }
  ],
  "warnings": []
}
```

Each run is stored in `~/.0/runs/<scan-id>/state.db`, with `report.json` beside it. Open the results in the browser app under **Findings**, or with `0 findings`. See [Findings](/findings/).

### Exit codes

`scan source` and `scan package` share these codes:

| Code | Meaning |
|---|---|
| `0` | Completed, no high or critical findings |
| `1` | Completed with at least one high or critical finding |
| `2` | Error, or the model analysis failed and only static results exist |
| `3` | Partial: no model was available, so the AI layer was skipped |
| `4` | Stopped at the cost ceiling; partial findings kept |

With no usable model, the scan still runs the static layer, exits `3` and records `aiAnalysisSkipped: true` in the report. That is not a clean result. Pass `--static-only` to skip AI on purpose; the scan then exits `0`, or `1` with high or critical findings.

## Limits

- A finding from source review is evidence at a source location. It is not a reproduced exploit until you [verify it](/verify-and-fix/).
- A clean run does not prove the absence of vulnerabilities. Coverage depends on depth, budget, model and the tools that ran.
- The static pass uses FoxGuard by default. Set `ZERO_STATIC=semgrep` to use Semgrep instead; it must be installed.
- Binaries without source are covered in [Specialist research](/research-workflows/#binaries).
