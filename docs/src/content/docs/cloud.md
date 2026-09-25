---
title: Cloud access and managed execution
description: Distinguish local provider access from managed repository workflows and current compatibility limits.
draft: true
pagefind: false
---

Cloud is not a prerequisite for using 0 locally. The public console brings
your own model connection; managed execution is a separate service:

| Arrangement | Models | Tools and execution | Setup |
| --- | --- | --- | --- |
| Local harness / BYOK | Your supported provider or subscription | Your configured executor | [CLI quickstart](/getting-started/) and [API Keys](/api-keys/) |
| Managed execution | As agreed for the workflow | Service-managed workers | Organization access, target authorization, supported service configuration and budget |

Free software does not imply free provider usage or infrastructure. Confirm
managed-service access, scope, budget and deployment compatibility with the
team; a signed-in account alone does not authorize managed execution.

## What is implemented

The CLI implements browser authentication for managed-service commands,
repository enrollment (`0 connect`) and managed lifecycle commands
(`0 service start/status/wait/cancel/disconnect`). The separate Cloud integration
implements scoped CLI-token authorization, GitHub App enrollment checks,
scheduling, status/cancellation, and evidence delivery. The public interactive
console uses your configured API key or provider subscription for model calls.

A successful `0 auth status` checks read access to managed scan records. It
does not authorize a new scan or configure a model in the local console.

The public [Cloud login](https://cloud.0.security/login) was reachable during
this documentation review. A reachable login page proves neither deployment
revision nor successful enrollment, billing, worker execution, or artifact
retrieval. Managed access should be confirmed with the team.

## Choose a workflow

- **Arrange managed testing:** [prepare an engagement](/cloud/getting-started/),
  including scope, a test command, service access and a stop procedure.
- **Connect GitHub reviews:** use the organization's GitHub App integration and
  repository policy. This is distinct from running the CLI in your own
  [GitHub Actions workflow](/ci/github-action/).
- **Review delivery:** inspect the scan record, evidence and coverage limits
  using [Review Evidence](/cloud/review-evidence/).

## Compatibility before automation

Do not infer service compatibility from command availability. The current CLI
and the reviewed Cloud integration still have mismatches around repository
schedule filtering and the one-shot service cost-ceiling field. Read the
[onboarding compatibility checks](/cloud/getting-started/#compatibility-checks)
before using enrollment or disconnect in an organization with schedules.

These guides describe source-backed behavior and its limits, not an end-to-end
production acceptance test. The review compared public CLI revision `708f0117`
with Cloud root revision `d2cb1a38` and the newer `website-integration-20260918`
worktree at `61e68bad`. The integration worktree contains managed APIs absent
from the older root checkout; neither local revision establishes what is
currently deployed. Public website and login observations were made on
2026-09-19. No authenticated execution or billing request was performed.

## Agent-operated codebase setup

The source implementation shares saved configuration between the dashboard and
the `project` CLI group. Check `0 guide --json` and `0 project --help` in
the installed version before using these commands:

```bash
0 project setup owner/repository --json
0 project show owner/repository --json
0 project history owner/repository --json
```

A coding agent reads source-backed observations, asks about conventions, test
commands, repair preferences and the budget, then saves an approved revision.
The dashboard can edit the same context. Starting a scan requires separate
approval and confirmed credit-backed admission; setup alone does not spend.

Use `0 skills --help` for versioned methodology files and codebase
assignments. Bundle file paths are relative to the working directory, with
`SKILL.md` as the entrypoint. A queued scan keeps its captured configuration
and methodology revisions even when a later revision is saved.

Scan-derived observations stay suggestions until explicitly reviewed and saved.
They are not automatic training. Slack notification setup remains optional.
Source/fixture qualification does not establish endpoint or engine deployment.

## Draft material

These pages remain excluded from public navigation/search while the managed
workflow's deployment and compatibility are qualified. Their operational
checks are useful to contributors and provisioned operators; publication is
not an access commitment.

- [Engagement preparation and lifecycle](/cloud/getting-started/)
- [Scope and access considerations](/cloud/scope-and-access/)
- [Evidence review](/cloud/review-evidence/)

For product status, see the [roadmap](/roadmap/#0cloud). For access and deployment
requirements, [contact the team](https://0.security/contact/?intent=contact).
