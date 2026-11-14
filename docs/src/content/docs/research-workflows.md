---
title: Specialist research
description: Pick the right research command for variants, binaries, kernels, protocols, identity, attack surface and AI agents, and know what its output proves.
---

Beyond `scan`, 0 has specialist commands under `0 research`, plus `0 eval` and `0 agent-assure` for AI systems. Each takes a different input and produces a different kind of evidence. Pick by task, then read what the output does and does not prove.

## Pick a command

| Task | Command | Output |
|---|---|---|
| Find variants of a known fix | [`research hunt`](#variant-hunting) | Leads, skeptic-gated |
| Mine broken preconditions | [`research assumption-hunt`](#variant-hunting) | Candidates to disprove |
| Hunt fresh kernel commits | [`research recency-hunt`](#kernel) | Leads |
| Fuzz C, C++ or Rust for memory bugs | [`research memsafety`](#memory-safety) | Reproduced crashes |
| Analyze a binary without source | [`research binary`](#binaries) | 0verse candidates |
| Check an HTTP server against an RFC | [`research protocol-check`](#protocols) | Confirmed or refuted divergences |
| Map a domain's attack surface | [`research recon`](#attack-surface) | Asset inventory |
| Assess Entra ID or Active Directory | [`research identity`](#identity) | Posture findings, attack paths |
| Test an AI endpoint | [`eval`](#ai-agents) | Category scorecard |
| Test whether an agent can be hijacked | [`agent-assure`](#ai-agents) | Evidence bundle |
| Export HackerOne program scope | [`research h1`](#hackerone) | Scope file |

Every command has full options in the [CLI reference](/commands/#research). Run only against targets you own or are authorized to test. Many of these commands build code, run fuzzers, boot VMs or send live traffic, so use a disposable machine.

## Evidence levels

Record what each result actually is before you disclose it:

| Result | What it establishes |
|---|---|
| Lead, candidate, hypothesis | A model or analyzer found something plausible. Nothing ran. |
| Source-backed confirmation | An independent model pass agrees with the source claim. No PoC ran. |
| Observed | A live request or an imported log showed the behavior. |
| Reproduced | A reproducer ran and met its oracle: a sanitizer crash, a KASAN report, a state change. |

A skipped stage, a missing tool or an empty result is not a clean bill of health. Keep result JSON together with the logs, inputs and artifacts it references. They may contain sensitive data.

## Variant hunting

```bash
0 research hunt --source ./linux --seed ./security-fix.patch \
  --ref CVE-2026-12345 --output hunt-leads.json
```

`hunt` reads a fix diff, ranks code sites with the same bug shape, runs finders on them and passes survivors through a skeptic. Exit codes: `0` leads found, `1` no leads, `2` no candidates, `3` error. `--no-verify` skips the skeptic (triage only). `--models a,b` adds finder diversity at extra cost. Kernel options such as `--reachable-only`, `--invariant`, `--graph-slice` and `--exploitability` (boots QEMU VMs) are listed in the [reference](/commands/#research-hunt).

For a commit in a smaller repository, `0 scan source ./repo --fix-commit <sha>` does the same inside a [source review](/scan-code/#hunt-variants-of-a-known-fix).

```bash
0 research assumption-hunt ./linux --files net/unix/af_unix.c,net/unix/garbage.c --subsystem net/unix
```

`assumption-hunt` mines a function's implied preconditions and finds callers that do not establish them. `--skip-hunt` stops after the deterministic caller scan, with no model finder.

## Memory safety

```bash
0 research memsafety https://github.com/your-org/parser.git --fuzz-timeout 120 \
  --artifact-dir ./memsafety-evidence
0 research memsafety ./rust-crate --language rust --miri
```

0 detects the language and build system (`Cargo.toml`, `CMakeLists.txt`, `configure.ac`, `meson.build`, `Makefile`), builds a sanitizer harness, fuzzes and reports crashes it reproduced. Exit codes: `0` loop completed, `2` skipped because a build system or toolchain was missing, `3` error. A skip is not a pass.

`0 research counterexample --source ./libfoo --fn parse_header --header include/foo.h --declaration "int parse_header(const uint8_t *buf, size_t len)"` searches one suspect C function for a sanitizer-confirmed input. For C libraries inside a full review, see [`--profile c-library`](/scan-code/#c-and-c-libraries).

## Binaries

```bash
0 research binary ./program --mode triage
0 research binary ./program --mode scan --backend ghidra --llm claude
```

`research binary` hands off to 0verse, the Python binary engine in the repository. It needs a source checkout of 0 (the `0verse/` directory) and `uv` on your `PATH`; the installed binary alone cannot run it. Backends are `ghidra` (preferred), `rizin` and `angr`; each must be installed separately.

`triage` identifies the file format, architecture and mitigations. It does not decompile or find bugs. `scan` decompiles, slices source-to-sink paths and applies bug-class lenses. Without `--llm`, 0verse uses a deterministic mock model, not real analysis. Static candidates stay leads until a replay confirms them. See the [0verse README](https://github.com/0sec-labs/0/blob/main/0verse/README.md) for setup.

## Kernel

```bash
# Hunt commits from the last 24 hours
0 research recency-hunt --tree ./linux-next --hours 24 --output recency.json

# Import crash reports, optionally verifying each in a VM
0 research ingest ./crashes/ --output json
0 research ingest --syz ./program.syz --kernel-tree ./linux --kernel-config kasan --output json

# Run a reproducer through repeated fresh boots
0 research linux --kernel-tree ./linux --reproducer ./repro.c --finding finding.json \
  --expected-signature "KASAN: slab-use-after-free" --boots 3 --min-hits 2
```

Other kernel commands: `research kernel variant-hunt` (FoxGuard rules against an advisory), `research kernel syzbot-mine` (rank syzbot's closed queue), `research kernel weights` (syzkaller choice weights), `research cve find` and `research cve adapt` (public PoCs), `research exploit` (escalate a confirmed bug toward root in a VM; a safe no-op without `--climb`), and `research xnu-fuzz` (macOS IOKit inputs; plans the VM run but does not launch it). `research linux-matrix` validates and hashes boot logs you ran elsewhere; it boots nothing.

VM execution needs a built guest. Follow [Kernel VM verification](/kernel-vm/) first. A cached build is not fresh evidence.

## Protocols

```bash
0 research protocol-check --spec ./rfc9110-excerpt.txt --impl ./server-parse.c \
  --target http://127.0.0.1:8080 --json
```

`protocol-check` hypothesizes where an implementation breaks a MUST-level rule, then exercises each hypothesis against the live server. Only divergences backed by an observed response are `confirmed`. Exit codes: `0` confirmed divergence, `1` none, `2` no validated model, `3` error.

`research specdrift extract|scan|plan --spec <file>` extracts cited invariants from a spec and maps them to source. It sends no traffic; its output is hypotheses.

## Attack surface

```bash
0 research recon example.com --json > assets.json
0 research recon example.com --active --scope ./scope.json --json
0 research js-recon https://app.example.com --json
```

`recon` collects subdomains from certificate transparency and DNS, then probes for API docs and MCP servers over HTTP. `--active` adds DNS brute-force. `js-recon` mines a page's JavaScript bundles for endpoints, API bases and redacted secrets. An inventory is not a vulnerability and not authorization. Authorize each target before you run [`scan web`](/scan-web/) on it.

Also here: `research intel` (advisory and CVE lookups, package dossiers), `research cloud s3-probe` and `research cloud validate-creds` (read-only AWS checks), `research npm-discovery` (runs untrusted package code on your host; requires `--i-understand-untrusted-exec`) and `research mobile` (passive APK/IPA intake).

## Identity

```bash
export ZERO_GRAPH_ACCESS_TOKEN=...
0 research identity --tenant 00000000-0000-0000-0000-000000000000 --scope ./graph-scope.json --json

0 research adgraph --input ./sharphound-export/
0 research entragraph --input ./azurehound-export/ --json
```

`identity` makes read-only Microsoft Graph requests with the token from `ZERO_GRAPH_ACCESS_TOKEN`; it never takes the token as an argument. With `--scope`, `graph.microsoft.com` must be in scope. `adgraph` and `entragraph` analyze exports you already collected, offline. Missing permissions or edges limit coverage. See [Scope and authorization](/scope/).

<span id="agent-action-assurance-agent-assure"></span>
## AI agents

### Probe an AI endpoint

```bash
0 eval --target https://ai.example.com/chat --list-categories
0 eval --target https://ai.example.com/chat --categories <ids> --format json
```

`eval` runs an attack agent per category against the endpoint and judges the transcript. It exits `1` if any category failed and `2` on error. A category `pass` means the judges found no failure in that attempt, not that the endpoint is safe.

### Test whether untrusted MCP content can trigger an action

```bash
0 agent-assure \
  --agent-endpoint http://localhost:8080/agent \
  --mcp-endpoint http://localhost:8081/mcp \
  --oracle-endpoint http://localhost:8082/state \
  --scenario ./scenario.json \
  --target-version v1.2.3 --policy-version v1.0.0 --model-version your-model-id \
  --environment staging --output ./evidence-bundle
```

You provide three endpoints: an agent test adapter, the MCP server the agent uses, and an oracle that reports real state changes. The scenario names the injection vector, a benign task, the payload and the prohibited action. 0 runs the task, injects the payload and asks the oracle whether the prohibited action happened. The output directory (default `agent-assurance-<run-id>`) holds a manifest that binds target, policy, model and tool versions to hashed evidence.

| Exit | Outcome |
|---|---|
| `0` | `not_observed` |
| `1` | `observed` |
| `2` | `inconclusive` or `error` |

`inconclusive` covers an oracle that did not finish, even if it reported a provisional observation. `not_observed` applies only to that scenario and observation window. With the scope plugin on, all three endpoints must be in `--scope`. `--baseline <manifest>` links a retest to an earlier run.

The repository also has fixture runners for MCP tool misuse, indirect prompt injection and persistence: `pnpm --filter @0/bench adversarial-tool-misuse --json` (and `adversarial-indirect-prompt-injection`, `adversarial-persistence`). They run against local fixtures with no real model, and a pass means expected categories were detected.

## HackerOne

```bash
0 research h1 auth
0 research h1 programs list
0 research h1 programs show your-program
0 research h1 scope dump your-program --out scope.json
```

Read-only access to the HackerOne hacker API. Set `H1_API_IDENTIFIER` and `H1_API_TOKEN`, or put the same `KEY=VALUE` lines (no `export`, no quotes) in `~/.0/h1.env` with mode `0600`. The identifier is the name you gave the API token, not your handle. `scope dump` writes to `~/.0/scopes/<handle>.json` unless you pass `--out`.

Exit codes: `0` success, `1` bad input, `2` auth failure, `3` rate limit or network error.

0 does not submit HackerOne reports. Read the program policy before automating anything; exported scope is not permission to scan. To draft an advisory, see [Reports and disclosure](/reports/#draft-advisories).

## Limits

- Most of these commands emit leads. Only `memsafety`, `protocol-check` confirmations, kernel VM runs with a matching oracle and `agent-assure` `observed` outcomes rest on execution.
- Model diversity flags (`--models`, `--attempts`) multiply cost. Set `--cost-ceiling` where a command offers it.
- Output directories do not contain every write. Builds, caches and models can land elsewhere on the host.
