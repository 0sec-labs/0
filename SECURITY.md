# Security Policy

## Reporting a vulnerability

Report vulnerabilities in 0 to **security@0sec.ai**. Do not open a public
issue for a suspected security flaw.

Include:

- a clear description of the issue;
- reproducible steps or a minimal test case;
- affected version or commit;
- potential impact and any mitigations already attempted.

Do not include customer data, production credentials, or exploit material for
third-party systems without authorization.

For execution-boundary or tool-approval reports, include the entrypoint
(console, command, dashboard, desktop, MCP, or 0verse), autonomy mode,
scope/exclusions, executor/runtime, and relevant feature flags. Redact tokens,
provider credentials, private target paths, and sensitive artifacts before
sharing logs. A minimal synthetic reproducer is preferable to a production
target or a live exploit.

This policy is for flaws in this repository's software. Findings produced while
assessing another system should go to that system's authorized disclosure
channel; using 0 does not grant permission to test it or publish its data.

## Supported versions

Security fixes are made against the latest tagged 0 release. If you build
from source, include the commit hash and affected component in your report.
The independent 0verse Python package and unreleased desktop source do not
share the CLI's release version; identify their checkout revision explicitly.

## Disclosure

We coordinate fixes and disclosure with reporters where practical. Public
advisories are published only after a fix or mitigation is available.
