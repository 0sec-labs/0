---
title: Recipes
description: Practical find, verify, and fix workflows for authorized web targets, source repositories, identity posture, and retained evidence.
---

Configure a provider using [Getting Started](/getting-started/), replace example
targets, and prepare authorization and scope before running these commands.

## Find, verify, and repair a repository

For a repository whose build and regression commands you know, commit the
baseline and run the complete lifecycle in a disposable worker:

```bash
0 secure ./my-app --setup-command "npm ci" --test-command "npm test" \
  --state-dir ../my-app-secure --runtime api --cost-ceiling 10 \
  > secure-result.json
```

`secure` investigates committed source, generates behavioral probes, tests
repairs, and replays the frozen probe in a fresh patched checkout. It does not
provision a sandbox, merge, or deploy. Inspect each `repairs[]` outcome and its
baseline/verification artifacts, plus `errors`; aggregate `completed` is not
proof every finding was repaired. `costUsd` is available metered usage, with
current cross-phase accounting limits, not a complete billing receipt. See
[the lifecycle, resume, and publication contract](/scan-workflows/#repository-lifecycle-with-secure).

If you already have one reproduced source finding, use the narrower route:

```bash
0 fix ./my-app --finding ./finding.json \
  --verification-result ./verification-result.json \
  --test-command "npm test" --output ./validated.apply-patch
```

The finding must contain `verificationSpec`, the result must be compatible
verification evidence, and the local Git worktree must be clean. The output is
apply_patch DSL, not a unified diff; omit `--apply` to leave the original
worktree unchanged. Do not pass an entire scan report as a single finding.

## Inventory a domain before choosing live targets

```bash
# CT/DNS discovery plus HTTP OpenAPI/MCP probes (not network-free).
0 recon example.com --json > assets.json

# Also permit scoped active DNS wordlist enumeration.
0 recon example.com --active --scope ./scope.json --json > active-assets.json
```

Review `assets` and `warnings`, obtain authorization for each selected target,
then run a separate `0 scan --target ... --scope ...`. Inventory membership is
not authorization and not a vulnerability. The current recon scope option
guards active enumeration only, not all DNS/HTTP discovery or redirects.
[Scope & Authorization](/scope/#requirements-differ-by-command) explains the
boundary.

## Hunt variants of a known source fix

```bash
0 hunt --source ./linux --seed ./security-fix.patch \
  --ref CVE-EXAMPLE --output ./hunt-leads.json
```

Supply a real fix diff and its provenance label. Hunt generates candidate sites
and uses a skeptic gate; output is leads, not confirmed zero-days. Its exits
describe discovery (`0` leads, `1` none, `2` no candidates, `3` error), not
repository safety. `--no-verify` skips that gate and is triage-only. Executable
kernel verification has separate VM prerequisites; see
[Research Workflows](/research-workflows/).

## Assess identity without changing the directory

With an approved Graph token supplied through `ZERO_GRAPH_ACCESS_TOKEN` and a
scope file allowing `graph.microsoft.com`:

```bash
0 identity --tenant 00000000-0000-0000-0000-000000000000 \
  --scope ./graph-scope.json --json > identity-result.json
0 adgraph --input ./sharphound-export/
0 entragraph --input ./azurehound-export/ --json
```

Replace the tenant ID. Identity makes live Graph GETs; the graph commands
analyze previously collected exports offline. Missing collection permissions or
missing graph edges limit coverage, not tenant risk. See
[identity and token analysis](/engagements/#identity-and-token-analysis).

## Scan a REST API (OpenAPI)

Seed reconnaissance with endpoints, parameters, and authentication requirements
from an OpenAPI 3.x or Swagger 2.0 document.

```bash
0 scan \
  --target https://api.example.com \
  --api-spec ./openapi.yaml \
  --mode web \
  --depth deep \
  --scope ./scope.json
```

If your API requires authentication, add `--auth` (see [Scan authenticated APIs](#scan-authenticated-apis-bearer-token) below). Live network targets require `--scope` — see [/scope/](/scope/).

## Scan a WordPress site for CVEs

Turn on the WordPress fingerprinter: it detects WordPress, lists plugins and
themes, checks them against a curated vulnerable-plugin catalog, reads versions
from `readme.txt`/`style.css`, and returns CVE hints before the attack loop
crawls.

`wp_fingerprint` queries the no-key WPVulnerability API by slug. Set
`WPSCAN_API_TOKEN` or `ZERO_WPSCAN_API_TOKEN` to merge WPScan API data too — still
without running the `wpscan` CLI or sending generic scanner traffic.

```bash
env ZERO_FEATURE_DYNAMIC_PLAYBOOKS=1 \
  0 scan \
  --target https://blog.example.com \
  --mode web \
  --depth deep \
  --features wp_fingerprint \
  --scope ./scope.json \
  --verbose
```

When the program explicitly allows scanner traffic, add `--allow-scanners`
to let the agent use tools like `wpscan`. Keep this off for scoped
HackerOne/Bugcrowd targets unless the policy permits generic scanners.

```bash
env ZERO_FEATURE_DYNAMIC_PLAYBOOKS=1 \
  0 scan \
  --target https://blog.example.com \
  --mode web \
  --depth deep \
  --scope ./scope.json \
  --allow-scanners
```

## Audit a package for security issues

```bash
# Latest npm version
0 audit express

# Pin a version
0 audit express --package-version 4.18.2

# PyPI package
0 audit requests --ecosystem pypi

# Deep audit with the Claude Code CLI
0 audit left-pad --depth deep --runtime claude
```

The pipeline acquires package material in a temporary directory for static,
advisory, and model review. Use a disposable environment for untrusted code;
subsequent investigation may invoke execution tools.

## Review a C/C++ library with sanitizer evidence

Use the C-library workflow to collect userspace C/C++ sanitizer evidence.

```bash
0 review \
  --target c-library \
  ./libfoo \
  --depth deep \
  --runtime claude
```

The C-library prompt asks the agent to begin with a tier-1 libFuzzer/AFL++
harness on a small reachable entrypoint, using ASan and UBSan. This is guidance,
not proof that a build succeeded. Programmatic integrations can scaffold
`scaffoldTier1Harness({ srcDir, entryFn, includeDirs })`, or use
`scaffoldTier2Harness({ srcDir, entryFn, componentFiles })` when the primitive
only matters through a wider API path.

Evidence should include the harness source, build/run commands, crashing input,
and sanitizer output. If the bug needs multiple components or process state,
escalate to tier-2/tier-3 rather than reporting a static-only finding.

## Verify a Linux kernel finding from a `.syz` program or C reproducer

This path prepares kernel VM artifacts from a local tree and runs the supplied
program through the kernel oracle. Arrange the QEMU/guest/toolchain prerequisites
in [Kernel VM Verification](/kernel-vm/) first. Build artifacts default to
`~/.0/kernel-cache/`; cache reuse is not fresh evidence of reproduction.

```bash
# Run a syzkaller .syz program with kasan build/cache preparation.
0 ingest \
  --syz ./program.syz \
  --kernel-tree ~/src/linux \
  --kernel-config kasan \
  --output json

# Run a C reproducer with a custom config name.
0 ingest \
  --reproducer ./poc.c \
  --kernel-tree ~/src/linux \
  --kernel-config defconfig+kasan \
  --output json
```

`--syz` and `--reproducer` are mutually exclusive and cannot be combined with a
crash-dump path; both require `--kernel-tree`. The direct output wraps
`kernelBuild` and `verification`, whose fields include `verified`, `reproduced`,
`crashMatch`, `evidence`, and `reason`. On this standalone route, `reproduced`
can mean the program executed even without a recognized crash; inspect
`verified` and the evidence, not that boolean alone.

The registered `--expected-signature` option is currently not forwarded by
`ingest` to the standalone oracle, so this recipe does not rely on it. The oracle
recognizes crash classes rather than enforcing that supplied signature.
`--output json` can still be preceded by progress text; do not assume all stdout
is one JSON document. Use `--force-kernel-build` to bypass cached builds or
`--kernel-cache-dir` for an alternate cache.

<span id="run-a-full-pentest-with-maximum-accuracy"></span>
## Compare verification gates

Enable the listed gates for a scoped evaluation. Measure detection and false
positives on your target; results vary by benchmark slice. EGATS stays separate
and opt-in.

```bash
env \
  ZERO_FEATURE_CONSENSUS_VERIFY=1 \
  ZERO_FEATURE_REACHABILITY_GATE=1 \
  ZERO_FEATURE_POV_GATE=1 \
  ZERO_FEATURE_MULTIMODAL=1 \
  0 scan \
  --target https://example.com \
  --mode web \
  --depth deep \
  --features fp-moat \
  --scope ./scope.json
```

See [Configuration — Feature flags](/configuration/#feature-flags) for what each flag does.

## Best-of-N racing for hard targets

For benchmark/CTF experiments, race five strategies. Parallel attempts consume
separate work budgets; inspect their combined cost and evidence.

```bash
0 scan \
  --target https://hard-target.example.com \
  --mode web \
  --race \
  --depth deep \
  --scope ./scope.json
```

## Export findings to GitHub Issues

Export the report's findings to a GitHub repository as labelled issues. This is an external write: confirm disclosure authorization first. The exporter does not impose a separate confirmed-only filter.

```bash
export GITHUB_TOKEN="ghp_..."

0 scan \
  --target https://example.com \
  --mode web \
  --scope ./scope.json \
  --export github:myorg/security-findings
```

Issues use literal `0`, `severity:critical` (and other severity values),
and `category:xss` (and other categories) labels. Existing open issues with the
same generated title are skipped. Issue creation does not reproduce a finding.

## Generate an HTML, Markdown, or PDF report

```bash
# HTML (auto-opens in browser and saves to a temp file)
0 scan \
  --target https://example.com \
  --mode web \
  --depth deep \
  --format html \
  --scope ./scope.json

# Markdown (printed to stdout; redirect to a file)
0 scan \
  --target https://example.com \
  --mode web \
  --depth deep \
  --format md \
  --scope ./scope.json > example-pentest.md

# PDF (auto-opens in your default viewer and saves to a temp file)
0 scan \
  --target https://example.com \
  --mode web \
  --depth deep \
  --format pdf \
  --scope ./scope.json
```

Reports render the evidence available for the selected workflow. Source and
package findings need not contain HTTP request/response pairs; a formatted report
does not add missing reproduction evidence. HTML/PDF paths are temporary and
viewer opening is best-effort. Copy generated files to durable storage.

## Scan authenticated APIs (bearer token)

```bash
# Inline
0 scan \
  --target https://api.example.com \
  --api-spec ./openapi.yaml \
  --auth '{"type":"bearer","token":"eyJhbGciOi..."}' \
  --scope ./scope.json

# From a file (avoids leaking the token to shell history)
cat > auth.json <<'EOF'
{"type":"bearer","token":"eyJhbGciOi..."}
EOF

0 scan \
  --target https://api.example.com \
  --api-spec ./openapi.yaml \
  --auth ./auth.json \
  --scope ./scope.json
```

Other auth types:

```bash
# Session cookie
--auth '{"type":"cookie","value":"session=abc123; csrf=def456"}'

# HTTP Basic
--auth '{"type":"basic","username":"admin","password":"hunter2"}'

# Custom header (API key)
--auth '{"type":"header","name":"X-API-Key","value":"sk_live_..."}'
```

## Track learned false positives across runs

Record human false-positive feedback as reusable investigation context. Select the same database that contains the finding:

```bash
# Mark a single finding as FP (auto-creates a memory)
0 triage mark-fp FINDING_ID --reason "test fixture echo endpoint, not reachable in prod" --db-path ./engagement.db

# Add a memory from an existing finding without suppressing it
0 triage memory add --finding FINDING_ID --reason "intentional CORS config for public API" --db-path ./engagement.db

# List what 0 has learned
0 triage memory list --db-path ./engagement.db

# Remove a memory that's no longer accurate
0 triage memory remove MEMORY_ID --db-path ./engagement.db
```

Replace placeholders with recorded IDs. Memories are stored in the chosen
database and can be recalled by matching scans; a different run-local database
does not automatically inherit them. The ordinary memory path needs no Jev
opt-in. Optional Jev memory ranking changes relevance ordering, not the finding's
truth: prior explanations remain untrusted context, and the current deployment,
permissions, and exploit path must be independently checked.
