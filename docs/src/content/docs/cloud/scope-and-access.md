---
title: Managed scope and access
description: Establish target authorization, organization and GitHub App access, execution constraints and data handling for managed work.
draft: true
pagefind: false
---

Managed access and target authorization are separate requirements. The
[Cloud overview](/cloud/) records the implemented integration and its current
availability and compatibility boundary; these checks do not imply that a
signed-in account is entitled to run every workflow.

Scope describes what may be tested. Reachability and credentials describe what
can be tested. Agree on both before execution; a reachable system is not
automatically an authorized target.

## Define the scope boundary

Prepare with the system owner:

| Item | What to specify |
| --- | --- |
| Targets | Exact application/API URLs or source repositories, environment, and relevant version or commit. |
| Authorization | Who owns each target and who can approve the requested testing. |
| Exclusions | Third-party services, production systems, paths, accounts, and data that must not be touched. |
| Allowed actions | Whether account creation, record mutation, uploads, emails, or other side effects are permitted. |
| Timing | Testing window, timezone, rate constraints, and maintenance periods. |
| Stop conditions | Who can stop the engagement, how to reach them, and events that require a pause. |
| Desired evidence | The security questions and reproduction detail needed for remediation. |

Do not use a broad wildcard when only a particular application is authorized.
Redirects, shared hosting, and third-party login pages can cross the intended
boundary. Identify those cases explicitly.

## Organization and GitHub App access

For managed repository enrollment, sign in to the correct Cloud organization,
then configure its GitHub App integration. Grant access only to the intended
repositories. GitHub sign-in authenticates an identity; it does not itself
install the App or make private repositories available to workers.

The enrollment endpoint checks a nonrevoked CLI token with `scans:dispatch`,
current organization membership, and a nonsuspended, nonremoved installation.
Repository access is checked against the synchronized installation inventory;
an all-repositories installation can also cover a matching owner before the
next inventory sync. A selected-repositories installation must include the
requested repository. An installation for a different owner is not sufficient.

If enrollment returns `github-app-not-installed`, use the supplied integration
URL. If it returns `repo-not-accessible`, check repository selection, owner and
installation state. Do not widen an installation to all repositories merely
to silence a failed readiness check.

These are access checks, not a complete legal authorization or runtime scope
policy. The CLI's `connect` and `service start` commands submit repository and
test/setup configuration; they do not upload a local `--scope` file or your
engagement brief. Agree separately on the permitted behavior of tests, setup
scripts, network access, repair publication and recurring runs.

GitHub App reviews are also distinct from recurring `secure` runs. App
repository policy can control whether reviews run on pull requests or pushes,
which branches are allowed, draft pull requests and skip labels. Confirm that
policy and the organization's available workflow before enabling automation.
See [GitHub CI](/ci/github-action/) for App versus self-operated Actions.

## Prepare authenticated access

Prefer dedicated, least-privilege test identities and synthetic data. For
cross-user or cross-tenant authorization testing, prepare distinct identities
with known ownership of separate test resources. One admin account cannot
represent every user boundary.

For each identity, record its intended role, tenant, permitted actions, and
expiry. Describe SSO, MFA, session expiry, IP restrictions, or other controls
that may prevent automated access. Agree on the supported access path. Do not
disable security controls broadly.

Keep secrets out of public issues and initial contact forms. Arrange credential
transfer with the team, then revoke temporary access at the agreed end of the
engagement.

Repository credentials do not authenticate a running application. A managed
source review with GitHub access cannot by itself establish authenticated API
or tenant coverage. Private networks, SSO and short-lived sessions need an
explicitly supported service-side access path; a target reachable from your
laptop may not be reachable from a managed worker.

## Make side effects explicit

Even a benign reproduction can change state or notify a real user. Agree on:

- Disposable records and accounts that may be created, changed, or deleted.
- Whether outbound email, webhooks, payment actions, or uploads are permitted.
- Limits on data read or returned as evidence.
- Cleanup responsibilities and the stop procedure.

If a test requires permission beyond the agreed scope, pause and get that
permission. Do not silently broaden the engagement to obtain a reproduction.

## Agree on data handling

Before transferring source, credentials, or target-derived evidence, confirm
storage, retention/deletion, authorized recipients, and any required processing
locations with the team. These are engagement requirements; a CLI provider
setting alone is not a managed-service data-residency commitment.

## Check readiness

Before the testing window, confirm that the agreed access path reaches the
right environment, test accounts still work, ownership of test records is
known, and the stop contact is available. Record unresolved blockers as coverage
limits, not clean results.

Before enabling recurrence, confirm its target ID, cron/timezone, per-run and
organization budgets, publication policy and schedule-removal procedure. The
current [client/server compatibility warnings](/cloud/getting-started/#compatibility-checks)
include an unfiltered schedule-list response: do not use repository disconnect
as a safe selective stop until that contract is resolved. Cancelling a scan
and disabling future schedules are separate operations.

For a scan you operate yourself, use the [CLI quickstart scope example](/getting-started/#run-your-first-scan)
and [Authorized Engagements](/engagements/) for engine-level controls. A managed
engagement brief is not automatically loaded as CLI configuration.

Use [Scope & Authorization](/scope/) for the canonical CLI policy format and
matching rules.

Next: [Review Evidence](/cloud/review-evidence/).
