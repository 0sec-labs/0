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
| Managed execution | As agreed for the workflow | Service-managed workers | Operator-provisioned access, target authorization, supported service configuration and budget |

Free software does not imply free provider usage or infrastructure. Confirm
managed-service access, scope, budget and deployment compatibility with the
team; an account or token alone does not authorize managed execution.

## What is implemented

The local CLI does not provide managed-service login, repository enrollment,
scan lifecycle, codebase configuration, or methodology commands. Those workflows
belong to the separately operated Cloud integration, which implements scoped
token authorization, GitHub App enrollment checks, scheduling,
status/cancellation, and evidence delivery. The local interactive console uses
your configured API key or provider subscription for model calls.

When an approved service integration requires a token, the operator supplies
`ZERO_CLOUD_TOKEN` explicitly (and `ZERO_CLOUD_HOST` if using a nondefault
deployment). Token presence does not authorize a scan or configure a model
provider. Confirm managed access and service compatibility with the team.

## Choose a workflow

- **Arrange managed testing:** [prepare an engagement](/cloud/getting-started/),
  including scope, a test command, service access and a stop procedure.
- **Connect GitHub reviews:** use the organization's GitHub App integration and
  repository policy. This is distinct from running the CLI in your own
  [GitHub Actions workflow](/ci/github-action/).
- **Review delivery:** inspect the scan record, evidence and coverage limits
  using [Review Evidence](/cloud/review-evidence/).

## Compatibility before automation

Do not infer a deployed service's compatibility from the local CLI. Confirm
repository schedule filtering, budget enforcement, and authorization with the
operator before automating enrollment or schedule changes.

These guides describe source-backed behavior and its limits, not an end-to-end
production acceptance test. The source review compared Cloud root revision
`d2cb1a38` with the newer `website-integration-20260918` worktree at
`61e68bad`; neither local revision establishes what is currently deployed.
No authenticated execution or billing request was performed.

## Agent-operated codebase setup

The managed dashboard and operator-approved service integrations can store
codebase context, operating plans and methodology revisions. An agent should
ask about conventions, test commands, repair preferences and budget before
proposing a revision. Saving setup is separate from authorizing or starting
a managed scan. Consult the operator for available interfaces; the local CLI
does not expose `project` or `skills` service commands.

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
