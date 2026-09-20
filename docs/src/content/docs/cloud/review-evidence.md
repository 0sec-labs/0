---
title: Review managed evidence
description: Retrieve managed scan records and available artifacts, distinguish evidence from status labels, and plan meaningful retests.
draft: true
pagefind: false
---

Use this guide for results from an authorized managed workflow. Delivery
depends on the service and workflow you were provisioned for; see the
[Cloud overview](/cloud/) for the source-review and deployment boundary.

Start with the tested scope and its limits, then inspect each finding. A report
is evidence about the tests performed. It does not guarantee that no other
vulnerabilities exist.

## Locate the scan and delivery

Keep the `scan_id` returned by `0 connect`, or the `id` returned by
`0 service start --json`. Inspect the record without starting another run:

```bash
0 service status SCAN_ID --json
0 service wait SCAN_ID --interval 5 --json
```

The record includes `status`, `target_id`, timing and cost fields, and may
include `final_report`. `wait` ends on `complete`, `failed`, `cancelled` or
`cost_exceeded`; its exit status alone does not distinguish those outcomes.
For a managed `secure` run, inspect the structured final result as well as the
outer scan status. In the reviewed service, a blocked secure result maps to
outer `failed` with `truncated_reason: "secure_blocked"`, rather than becoming
a clean result.

The dashboard's organization-scoped scan detail page links to an **Evidence
bundle**, with a print-friendly view at
`/<orgSlug>/scans/<scanId>/artifact-bundle`. Use the actual organization route
from the dashboard; the CLI's printed `/cloud/scans/<id>` link is not a
substitute for resolving your organization's route.

### Reports and stored artifacts are different

The reviewed Cloud integration implements these authenticated read surfaces
under the configured dashboard host:

| Endpoint | Delivery |
| --- | --- |
| `GET /api/scans/<id>` | Scan record and available `final_report`. |
| `GET /api/scans/<id>/artifact-bundle` | JSON evidence/report bundle. |
| `GET /api/scans/<id>/artifact-bundle.zip` | ZIP bundle; `preset=filing` selects the filing-oriented layout. |
| `GET /api/scans/<id>/artifacts` | Stored-artifact receipts with `sha256`, `size_bytes`, `media_type` and `captured_at`. |
| `GET /api/scans/<id>/artifacts/<sha256>` | Bytes for an authorized, stored artifact matching that receipt. |

These endpoints require account scope and organization access; they are not
public URLs just because you know a scan ID. The ZIP route can also accept a
service-issued expiring signed URL. Treat that URL as sensitive access, not
something to paste into a public issue.

An evidence bundle assembled from scan records is not proof that every
worker-local file was uploaded. Stored-artifact delivery requires a configured
object store and a successful upload/receipt. A missing receipt, unavailable
store or failed download must be reported as a delivery gap. Do not convert
paths in `final_report` into guessed download URLs, and do not assume that
status/wait downloads files: these CLI commands return scan records only.

The endpoints above are source-backed integration capabilities, not a claim
that every deployment has artifact storage configured. Agree on recipients,
retention and delivery format before the run.

## Check coverage first

Compare the delivery against the agreed targets, environment, version,
identities, and testing window. Identify any targets or workflows blocked by
access, expired credentials, budget, setup failures, or unavailable
dependencies.

A completed run is not the same as complete coverage. Ask for clarification
when the record does not explain whether a security boundary was exercised.

## Read a finding

For each finding, check:

1. **Affected surface** — endpoint, component, or source location and tested version.
2. **Preconditions** — required identity, role, tenant, configuration, or existing access.
3. **Reproduction** — steps and input that exercised the suspected issue.
4. **Observed evidence** — actual execution output, distinct from model predictions.
5. **Impact and limits** — what the evidence proves and what remains untested.
6. **Remediation** — proposed fix and how to test the relevant boundary again.

Handle evidence as sensitive: request/response bodies, screenshots, paths, and
logs can contain credentials or personal data. Share only with agreed
recipients and redact before moving into a public issue.

## Separate proof from triage

A candidate is a lead to investigate. Verification checks whether the suspected
behavior can be reproduced. Human triage decides how to handle the finding.
These are different decisions. Severity and a lifecycle label do not replace
reproduction evidence.

The [Blind Verification](/blind-verification/) guide explains the independent
verification approach. When a delivery includes a deterministic
`verification_result`, use the [Verification Results](/verification-result/)
contract rather than guessing from process exit codes or a summary sentence.
Not every evidence artifact uses that contract.

## Plan a retest

Provide the finding identifier, patched version or deployment, fix description,
and any changed access requirements. Agree on retest scope before running,
especially if production access or state-changing actions are involved.

A useful retest checks both the original failure condition and the expected
allowed behavior. If an expired account, unreachable target, or broken setup
prevents the test, the outcome is not proof of remediation. Record the blocker
and rerun when valid conditions are restored.

For local reproduction and verification tooling, see [Commands](/commands/)
and [Verification Results](/verification-result/). A CLI artifact path is not a
public download URL; use the delivery mechanism agreed for the engagement.

## Resolve incomplete evidence

| Gap | Ask for |
| --- | --- |
| No tested version or identity | The environment and preconditions needed to interpret the result. |
| Impact described without an observation | The reproduction and evidence supporting the claim. |
| No reproduction after a fix | A retest under valid conditions, not just a changed lifecycle label. |
| Access or setup failure | An explicit coverage limitation and a plan to remove the blocker. |
| Evidence cannot be shared safely | A redacted artifact or an agreed restricted review path. |

Return to the [Cloud overview](/cloud/) or [prepare another engagement](/cloud/getting-started/).
