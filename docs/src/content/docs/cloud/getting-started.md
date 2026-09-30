---
title: Managed onboarding and lifecycle
description: Prepare authorized managed work and coordinate service access, enrollment, monitoring and cancellation with the operator.
draft: true
pagefind: false
---

Managed repository workflows depend on your organization and the deployed
service. The local CLI no longer provides managed-service authentication,
enrollment, or scan lifecycle commands. Use the [Cloud overview](/cloud/) for
the distinction between local tools and managed execution.

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

### Service access

The team provisions organization access and scoped service tokens separately
from local model-provider credentials. For an approved service integration that
requires a token, supply `ZERO_CLOUD_TOKEN` explicitly; set
`ZERO_CLOUD_HOST` only when the operator supplies another deployment URL.
The default host is `https://cloud.0.security`. Do not put tokens in a
repository or send a production token to an untrusted host. A browser cookie,
GitHub sign-in, or provider API key does not authorize managed work.

The operator must also confirm organization membership, appropriate token
scopes, GitHub App installation and repository access, and the organization's
permission for the requested workflow. Token presence alone is not a readiness
check. Arrange revocation with the operator if a token is exposed; clearing an
environment variable does not revoke an issued token or stop running work.

### Repository enrollment, monitoring and stopping work

Agree on the target repository, test and setup commands, recurrence, budget,
publication policy, and stop procedure before the operator dispatches work.
Ask the operator to confirm the deployed service's repository schedule filtering
and budget contract; an unfiltered schedule lookup can affect unrelated
repositories. Do not assume a scheduling failure means the first run was
cancelled or that a cancellation request stopped an active worker.

Record the service-issued scan and schedule identifiers, inspect the final
scan status and report, and use the agreed stop contact to request cancellation
or target-specific schedule removal. Removing a schedule does not cancel an
already-running scan or revoke the GitHub App grant.

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
| No managed access yet | Contact the team to arrange authorization. Use local/BYOK independently if appropriate. |
| Target is private or behind SSO | Describe the access constraint without sending credentials in the form. Agree on a reachable test path. |
| Testing authorization is unclear | Resolve permission and exclusions with the system owner before execution. |
| Need a specific integration or delivery format | Confirm it during scoping. Do not assume it is generally available. |
| Enrollment blocked | Ask the operator to resolve token scope, organization membership, GitHub App installation or repository selection before retrying. |
| Scan created but schedule failed | Ask the operator to inspect the scan ID; do not blindly repeat enrollment. |
| Scheduled work must stop | Confirm target-specific schedule IDs with the team and request cancellation of existing runs separately. |

Continue with [Scope & Access](/cloud/scope-and-access/).
