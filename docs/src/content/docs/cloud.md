---
title: Cloud access and managed execution
description: Distinguish local execution, hosted model access, and managed repository workflows, including current compatibility limits.
draft: true
pagefind: false
---

Cloud is not a prerequisite for using 0. Choose the execution and model-access
arrangement that matches your requirements:

| Arrangement | Models | Tools and execution | Setup |
| --- | --- | --- | --- |
| Local harness / BYOK | Your supported provider or subscription | Your configured executor | [CLI quickstart](/getting-started/) and [API Keys](/api-keys/) |
| Local harness / hosted models | Requests through 0cloud | Still your configured executor | Cloud sign-in, compatible account and hosted model access |
| Managed execution | As agreed for the workflow | Service-managed workers | Organization access, target authorization, supported service configuration and budget |

The [pricing page](https://0.security/pricing/) separates hosted model access
from managed execution. Free software does not mean free provider usage or
infrastructure. Confirm current plans and access with the team; this guide does
not promise included usage, a public production qualification, or managed
execution for every signed-in account.

## What is implemented

The public CLI implements browser authentication, hosted account/model queries,
repository enrollment (`0 connect`), and managed lifecycle commands
(`0 service start/status/wait/cancel/disconnect`). The Cloud integration source
also implements scoped CLI-token authorization, GitHub App enrollment checks,
secure-run scheduling, scan status/cancellation, and evidence delivery. These
are real integration paths, not just editable onboarding mockups.

They are **not interchangeable account capabilities**. In the reviewed server
source, an inference-only organization cannot enqueue scans, and a review-only
organization cannot enqueue a `secure` run. A successful `0 auth status` checks
an authenticated inference-account endpoint; it does not authorize managed
execution or prove that a model request will be admitted.

The public [Cloud login](https://cloud.0.security/login) was reachable during
this documentation review. A reachable login page proves neither deployment
revision nor successful enrollment, billing, worker execution, or artifact
retrieval. Managed access should be confirmed with the team.

## Choose a workflow

- **Use hosted models locally:** follow [Hosted models](/getting-started/#hosted-models)
  and inspect account eligibility before making requests. Shell tools do not
  move to the service merely because you sign in.
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
