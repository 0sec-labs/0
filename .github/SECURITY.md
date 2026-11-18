# Security Policy

## Reporting a vulnerability

Report vulnerabilities in 0 privately using GitHub's
[Report a vulnerability form](https://github.com/0sec-labs/0security/security/advisories/new).
Private vulnerability reporting is enabled for this repository.

For email reporting, contact **admin@0.security**.
Do not open a public issue for a suspected security flaw.

Include:

- a clear description of the issue;
- reproducible steps or a minimal test case;
- affected version or commit;
- potential impact and any mitigations already attempted.

Do not include customer data, production credentials, or exploit material for
third-party systems without authorization.

For execution-boundary or tool-approval reports, include the entrypoint
(console, command, dashboard, desktop, MCP, or 0verse), autonomy mode,
executor/runtime, and relevant feature flags. Redact tokens,
provider credentials, private target paths, and sensitive artifacts before
sharing logs. A minimal synthetic reproducer is preferable to a production
target or a live exploit.

This policy is for flaws in this repository's software. Findings produced while
assessing another system should go to that system's authorized disclosure
channel; using 0 does not grant permission to test it or publish its data.

## Extension and MCP execution trust

Extensions and custom MCP servers run code as the user on the engine host. They
are not sandboxed. The guardrails are review and pinning, not isolation:

- nothing runs on install; you read one prompt (repository at the full commit,
  files, what it can run, connect to or call) and approve the exact revision, from
  your own terminal or the browser, never from a command a thread ran;
- git extensions are fetched without executing anything, pinned to a full commit
  SHA, installed disabled, and never auto-update; any change re-prompts;
- an MCP server's tools are hashed per tool and a changed, new or removed tool
  blocks the whole server until you approve again;
- these routes are browser-only (agent/engine-bearer callers are refused) and
  owner-only in team mode; a process gets a scrubbed environment plus only the
  variable names you approved;
- the one exception is the engine operation endpoint, which lets an attached
  engine or MCP client call `save_workflow` (validated, revision-guarded) so
  workflows can be authored remotely; it cannot install extensions or MCP servers;
- an approved extension or server can still read files, use the network and
  prompt-inject the agent through tool names, descriptions and output.

Reports that bypass the review, pinning, caller or secret-handling rules are in
scope. Behaviour of an approved third-party extension is not a flaw in 0. See
the [security model](https://docs.0.security/configuration/#security-model).

## Self-edit preview

`ZERO_SELF_EDIT=1` (off by default) lets the dashboard create a `self/*` git
worktree and run a preview of an agent-edited copy of 0 on loopback ports with
an empty scratch home and an allow-listed environment. Guardrails:

- owner-only in team mode and unavailable to engine-bearer callers;
- a protected-path gate, evaluated by the live dashboard (not the agent) and
  failing closed, rejects diffs touching authentication, approvals,
  session and credential storage, the self-edit code itself, dependencies and
  lockfiles, build config, CI and agent instructions;
- apply is not implemented: nothing is promoted to the running dashboard;
- framing is limited to an exact loopback origin
  (`ZERO_PREVIEW_FRAME_ANCESTORS`, set by the launcher); everything else stays
  `frame-ancestors 'none'`.

The preview backend is agent-edited code running as the same OS user. It is not
a filesystem or network sandbox, so enable it only on a machine and account
where that is acceptable. Escapes from the protected-path gate or the scratch
home are in scope.

## Supported versions

Security fixes are made against the latest tagged 0 release. If you build
from source, include the commit hash and affected component in your report.
The independent 0verse Python package and unreleased desktop source do not
share the CLI's release version; identify their checkout revision explicitly.

## Disclosure

We coordinate fixes and disclosure with reporters where practical. Public
advisories are published only after a fix or mitigation is available.
