---
title: White-box Mode
description: Add local source context to a scoped live scan, then distinguish discovery evidence from source repair and execution isolation.
---

White-box mode gives a live-target investigation local source context. This can
help the agent trace routes, middleware, and data flows that HTTP-only probing
does not expose. Source observations are leads: hardcoded values, unsafe-looking
code, or a hypothesized authorization gap still need an applicable evidence
check. Providing source does not prove that it matches the deployed revision.

## How to use it

Pass `--repo` alongside your target, pointing at the root of the source running
behind the URL (local checkout, clone, or mounted CI volume):

```bash
0 scan --target http://localhost:8080 --scope ./scope.json --repo ./my-app
```

`--repo` is a local directory visible to the process, not a Git URL that `scan`
clones or an instruction to start the application. Prepare the checkout and
running target yourself, use a matching revision, and include localhost in the
scope file when testing locally. For source-only work, use `0 review ./my-app`;
for discovery through repair, use
[`0 secure`](/scan-workflows/#repository-lifecycle-with-secure).

In the benchmark runner, `--white-box` sets the repo path to the challenge
directory:

```bash
pnpm --filter @0/benchmark exec tsx src/xbow-runner.ts --agentic --white-box
```

## What changes

**Extra source tools.** The attack stage adds `read_file` (numbered source
windows) and `run_command`. The latter uses an analysis-command allowlist and
validates paths/cwd against the local source directory in non-YOLO mode.
These controls do not make the entire scan read-only: `bash`, browser actions,
and live requests retain their own effects and authority checks.

**Source-analysis guidance.** The web prompt requests a "Phase 0" of 2–3 turns
to read entry points, map routes to handlers, and investigate unsafe input,
SQL construction, `eval`/`exec`, file operations, weak authorization, and secrets.
This is prompt guidance, not a mandatory completed phase or a whole-repository
coverage guarantee. Deterministic reconnaissance can already have touched the
target before this attack-stage guidance runs.

## What it enables

- **Hardcoded credentials** — passwords, API keys, SSH keys in source, env
  defaults, or config templates.
- **Server-side logic flaws** — auth bypasses that look correct over HTTP but
  are visible in code (missing role checks, TOCTOU races, type confusion).
- **Data flow analysis** — trace user input through every transformation to the
  sink, revealing injection points that survive partial sanitization.
- **Unexposed attack surface** — admin routes, debug endpoints, and internal
  APIs registered in code but not linked anywhere public.

## Benchmark results

Historical white-box benchmark observations include XBEN-042 "Too much trust"
(hardcoded SSH credentials, where source exposed a path missed by HTTP-only
probing) and failures even with source, such as XBEN-092. These are
challenge-specific observations, not current universal guarantees. See
[Benchmark](/benchmark/) for the dated benchmark evidence and per-challenge
scores.

## When to use it

- **Pre-release audits** — you have source and a staging deploy.
- **Internal pentests** — authorized source access and a matching deployed target.
- **When black-box stalls** — re-run with `--repo`.
- **CTFs / benchmarks** — source-available challenges.

Skip for third-party targets without source, most bug bounty programs, or when
the external-attacker threat model is required.

## Tool set

The shell-first attack set includes `bash`, finding submission, completion,
payload lookup, and agent delegation. With `--repo`, it also includes
`read_file` and `run_command`; browser support and feature flags add optional
tools. It is not a fixed seven-tool interface.

The verify role can include file-edit tools as well as reads when source context
is present. Use a disposable checkout without unrelated secrets, not your only
working copy. A successful model verification is separate from executable
reproduction or a validated source repair. Follow
[verification and fixing](/scan-workflows/#verification-and-evidence) with the
finding's actual evidence contract.

## Internals

`--repo` sets `config.repoPath`, which controls two things:

1. **Prompt.** `shellPentestPrompt` injects the white-box section when
   `repoPath` is present.
2. **Tools.** Attack tool selection adds source tools, and attack context receives
   `scopePath: config.repoPath`. Verification tool selection uses
   `getToolsForRole("verify", { hasScope: !!config.repoPath, ... })`.
   Here `hasScope` selects local-source tools; it is not the network
   authorization policy. Tool selection alone does not establish that every
   execution path has a usable filesystem scope.

The implementation lives in `packages/core/src/agent/prompts.ts`,
`packages/core/src/agentic-scanner.ts`, and `packages/core/src/agent/tools.ts`.
Filesystem path checks and an HTTP scope policy are application controls, not
a filesystem mount, firewall, container, or VM boundary.
