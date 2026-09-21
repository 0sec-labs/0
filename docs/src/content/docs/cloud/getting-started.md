---
title: Managed onboarding and lifecycle
description: Prepare authorized managed work, authenticate the CLI, and understand enrollment, scheduling, cancellation and compatibility.
draft: true
pagefind: false
---

The CLI and Cloud integration implement managed repository workflows, but
availability depends on your organization and the deployed service. Use the
[Cloud overview](/cloud/) for the distinction between local tools, hosted
models and managed execution, and for this guide's source provenance.

## 1. Prepare a short brief

Describe the systems you own or are authorized to test, the environment (staging
or production), and the security question you need answered. Include the
expected delivery window and any restrictions that affect testing.

For example:

```text
Target: our staging web application and its API
Goal: test whether users can access another tenant's records
Access: dedicated test accounts for two tenants can be provided
Excluded: production, payment processing, and third-party identity services
Constraints: agree on request rate, testing window, and a stop contact
Deliverable needed: reproduction evidence and a retest after remediation
```

This is an engagement brief. Testing is not authorized until the scope and
rules of engagement are agreed.

## 2. Contact the team

Open [Contact the team](https://0.security/contact/?intent=contact) to discuss
managed work. Describe your organization, authorized targets and access
constraints. Availability, deliverables and commercial terms must be agreed
before work starts.

Do not paste passwords, API keys, session cookies, customer records, or private
source code into the contact form. Describe the access you can provide; agree on
how to transfer sensitive material separately.

Submitting the contact form does not start a scan or purchase a plan. Managed
access and execution are arranged with the team.

## 3. Agree on scope and access

Work through [Scope & Access](/cloud/scope-and-access/). Confirm authorized
targets, excluded systems, accounts, permitted actions, execution window, and
stop procedure.

Also confirm commercial and delivery terms: engagement depth, outputs,
recipients, data handling, and whether retesting or recurring work is included.
CLI [turn and cost limits](/budget-management/) are engine controls, not managed
engagement pricing.

### Authenticate and check the account

For an account provisioned by the team:

```bash
0 auth login
0 auth status
```

Browser login opens `https://cloud.0.security/cli-auth?session=…` by default.
Choose the intended organization and approve the requested grant. The CLI
polls for a ready token and saves credentials in `~/.0/cloud.env` with mode
`0600`. `ZERO_CLOUD_TOKEN` in the environment takes precedence over that file;
`ZERO_CLOUD_HOST` can select an agreed service host. Do not send a production
credential to an untrusted host. A manually supplied `--token` is saved without
being validated; run `0 auth status` afterwards.

`auth status` checks the inference-account endpoint, not just server health.
It is not a managed-run readiness check. Managed enrollment additionally needs
organization membership, a `scans:dispatch` grant, a nonsuspended GitHub App
installation and repository access. Scan reads use `scans:read`; account
capabilities remain separate from token scopes. Inference-only accounts cannot
start scans, and review-only accounts cannot start `secure` runs.

Production-profile login also attempts to write compatible credentials for the
separate `0cloud` client at `~/.0cloud/credentials.json`; the saved `orgId` is
empty, not a selection of every organization. Development-profile login keeps
that file untouched. Do not assume credentials from another client, a browser
cookie, or a provider API key are automatically accepted by this CLI.

`0 auth logout` removes the current profile's saved credentials, and in the
production profile also removes the compatible `~/.0cloud/credentials.json`.
It does not revoke the server-side token, clear an environment-provided token,
cancel runs or delete schedules. Remove injected credentials separately and
arrange server-side revocation if a token has been exposed.

### Repository enrollment

After the team confirms the compatibility checks below, the CLI entry point is:

```bash
0 connect https://github.com/example/authorized-repo \
  --test-command "npm test" \
  --setup-command "npm ci" \
  --no-schedule \
  --publication-policy off
```

This is an execution command, not a preview: after confirmation it enqueues a
`secure` run. With no repository argument it uses the current checkout's
`origin`. Without `--test-command`, it tries local project detection or a
shallow clone; review the detected command before approving it.

Without `--no-schedule`, the default is a recurring `0 3 * * *` schedule
(03:00 UTC). `--cron` changes that expression. `--yes` approves without a prompt;
JSON automation uses `--format json` and must explicitly pass `--yes` to
dispatch. `--publication-policy off` is the default: do not assume enrollment
publishes a repair PR. `manual` and `auto` are publication requests subject to
the service's policy and access.

The CLI checks enrollment and existing schedules before dispatch. If it finds
a schedule, it returns `state: "no-open"` without starting another run or
updating that schedule. A new run is created **before** its schedule. If
recurrence fails, `schedule-creation-failed` includes `scan_id`: inspect that
run before retrying, because the first run may already be executing.

### Compatibility checks

The source review found these unresolved client/server differences. Confirm
the deployed versions with the team rather than trying repeated paid runs:

| Boundary | Current source behavior | Safe operator action |
| --- | --- | --- |
| Repository schedule lookup | The CLI sends `GET /api/scan-schedules?target=<repo>`, but the reviewed server returns all schedules in the caller's organization without applying `target`. | Do not rely on `connect` to identify an existing schedule for the requested repository. Resolve the target and schedule IDs with the team first. This also affects `--no-schedule`, because lookup happens before one-shot dispatch. |
| Repository disconnect | `service disconnect` deletes every schedule returned by that lookup. | Do **not** use it against the unfiltered server contract: it can remove schedules for other repositories in the same organization. Request removal of the specific schedule IDs instead. |
| One-shot budget | `service start --cost-ceiling` sends `secure_config.cost_ceiling`; the reviewed server expects `secure_config.cost_ceiling_usd`. `connect` uses the latter field. | Do not treat the one-shot flag as an enforced service cap. Confirm a server-side budget before starting work. |
| Older service revision | The older Cloud root checkout lacks the newer integration's secure schedule contract. | Confirm the deployed revision supports the requested mode and fields. A public login is not evidence of that deployment. |

`0 service start --repo <url> --test-command <command>` is the lower-level
one-shot dispatch command. Unlike `connect`, it does not perform the same
enrollment checks or ask for confirmation. It still needs a compatible,
authorized account and service; it is not a way to bypass missing access.

### Monitor and stop work

Use the scan ID returned at dispatch:

```bash
0 service status SCAN_ID --json
0 service wait SCAN_ID --interval 5 --json
0 service cancel SCAN_ID --json
```

`wait` stops at `complete`, `failed`, `cancelled`, or `cost_exceeded` and emits
the final scan record. Reaching a terminal state does **not** make the CLI exit
nonzero for a failed scan. Automation must inspect `status` and `final_report`
rather than interpreting exit zero as a successful security outcome.

Cancellation of a running scan is a request, not immediate proof that its
worker stopped. An unclaimed pending scan can become `cancelled` immediately;
otherwise poll status until the service records the terminal outcome. A
noncancellable scan can return HTTP 409. Cancelling one run does not remove its
schedule. Removing a schedule does not cancel an already running scan or revoke
Cloud credentials,
or uninstall the GitHub App. Use the agreed stop contact if you cannot confirm
termination or safely remove recurrence.

## 4. Review the outcome

Use [Review Evidence](/cloud/review-evidence/) when results are delivered.
Check what was tested and what was blocked, inspect reproduction evidence, and
agree on the next action for each finding.

A retest request should identify the finding, the remediation, the target
version or deployment, and any changed access requirements. Do not treat a scan
that could not reach the target as proof that a fix worked.

## If you cannot proceed

| Situation | Next action |
| --- | --- |
| No managed access yet | Contact the team; a Cloud login or hosted-model account does not grant managed execution. Use local/BYOK independently if appropriate. |
| Target is private or behind SSO | Describe the access constraint without sending credentials in the form. Agree on a reachable test path. |
| Testing authorization is unclear | Resolve permission and exclusions with the system owner before execution. |
| Need a specific integration or delivery format | Confirm it during scoping. Do not assume it is generally available. |
| Enrollment blocked | Inspect the reported `reason`: resolve token scope, organization membership, GitHub App installation or repository selection before retrying. |
| Scan created but schedule failed | Inspect the returned `scan_id`; do not blindly repeat enrollment. |
| Scheduled work must stop | Confirm target-specific schedule IDs with the team, and cancel existing runs separately. Observe the compatibility warning above. |

Continue with [Scope & Access](/cloud/scope-and-access/).
