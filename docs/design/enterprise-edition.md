# Enterprise edition: a private repo on top of the open-source engine

Status: proposal (2026-11-15). Nothing here is built. Facts below were read from
the code on `main`; open decisions are listed at the end. No prices appear here.

## Principles

- **Open core.** Everything that exists in `0` today stays open source. Enterprise
  adds capabilities; it never removes or degrades an open-source one.
- **Bring your own keys and compute.** No hosted inference, no hosted sandboxes.
  Enterprise features run on the customer's own machines and servers.
- **One binary.** Customers run the same `0` command. Enterprise is code that the
  binary loads when a valid license is present, not a fork.
- **CLI first.** Every enterprise feature is configurable from the CLI and a config
  file; the browser app is a view over the same operations.
- **No phone home for licensing.** A license is a signed file verified offline.

## What the paid version adds

Modeled on what promptfoo sells (SSO, RBAC with custom roles, audit logging through
an API, service accounts for CI, team sharing, integrations, support and an SLA),
mapped to what `0` already has:

| Capability | Open source today (verified) | Enterprise adds |
|---|---|---|
| Sign-in | Local accounts with scrypt hashes; OIDC with PKCE (`team-auth.ts`) | SAML, group-to-role mapping, SCIM provisioning |
| Roles | Fixed `owner` / `editor` / `viewer`; route access decided by regex lists in `authorizeTeamApi` (`team-web.ts`) | Custom roles with named permissions |
| Audit | Local SQLite audit log, allowlisted detail keys, secret scrubbing, rotated at 50,000 rows (`storage/audit-log.ts`) | Export and streaming (webhook, SIEM), retention policy, tamper-evident chain |
| CI access | Read-only Findings API tokens (`read:findings`, optional expiry); GitHub Action with report artifacts | Named service accounts with a role, expiry and rotation |
| Team sharing | One engine per team workspace; remote engines the console dials into | Aggregated view across engines, shared config and policy (only when a customer needs it; see `shared-server.md`) |
| Integrations | GitHub issues exporter; third-party connectors are MCP-server plugins | Slack, Jira and similar sinks, SIEM forwarding, ticket sync |
| Policy | Scope matcher with an injectable policy (`opts.scope`); off unless the scope plugin is enabled | Signed, tighten-only policy distribution |
| Support | Community and GitHub issues | Support channel, response targets, release channels, deployment help |

## Seams that already exist in the open-source code

- **Event sinks.** `packages/engine/src/events/bus.ts` has an `EventSink` interface and
  `eventBus.subscribe(sink)`. Sinks are added at runtime, fan-out is defensive (a
  throwing sink never aborts a scan). Slack, Jira and SIEM forwarding fit here.
- **Plugins.** The plugin system loads fingerprint-approved, sandboxed, permission-gated
  executable plugins that speak newline-delimited JSON over stdio, plus MCP-server
  plugins. `ZERO_REGISTRY_URL` points the CLI at another registry index.
- **Scope injection.** The scanner already accepts an in-memory scope.

## Seams added to the open-source engine

All five landed as separate PRs with no behavior change by default (2026-11-15):

1. **Permissions, not route regexes** (#359, `team-permissions.ts`). Replace the regex lists in `authorizeTeamApi`
   with named permissions and a `PermissionPolicy` that maps role to permissions. The
   default policy reproduces owner / editor / viewer exactly. Enterprise supplies a
   policy with custom roles.
2. **Identity provider interface** (#360, `team-identity-provider.ts`). An installed provider handles `beginSSO` and `callback`; built-in OIDC is untouched when none is installed. Put OIDC behind an `IdentityProvider` interface so
   SAML and SCIM can be supplied by an enterprise plugin without touching the auth core.
3. **Audit sink** (#361, `addAuditSink`). Route audit writes through a registry so a plugin can mirror or
   stream every event. Keep the local log as the default and its scrubbing unchanged.
4. **Entitlements** (#362, `entitlements/license.ts`; inert until a public key is pinned in `PINNED_LICENSE_KEYS`). A small `entitlements` module: read a signed license file, verify
   it offline against a pinned public key, expose `has("sso")`-style checks. Without
   a license nothing enterprise loads and nothing in open source changes behavior.
5. **Plugin signatures** (#363, `ZERO_REGISTRY_PUBLIC_KEY_FILE`). The plugin docs said registry entries are `unverified` because no
   signature verifier is configured. A paid plugin channel needs one before it can be
   trusted. This is the prerequisite for distributing enterprise code as plugins.

## How enterprise code is packaged

Verified constraint: the `@0/*` packages are `private` and not published to npm, so a
separate repo cannot simply depend on `@0/engine`. Two workable shapes:

- **A. Plugins (recommended).** The enterprise repo builds signed plugin packs that speak the
  existing plugin protocol and subscribe to events through it. It needs no source
  dependency on the engine. The seams above expose what plugins need.
- **B. In-tree build.** The enterprise repo checks out `0` at a pinned commit and builds an
  enterprise binary. Simpler to write, but it drifts from the open-source release and
  makes upgrades a build exercise for every customer.

Recommendation: A, with B only if a capability cannot be expressed through the plugin
protocol (for example the auth core itself, which would then be a seam change in `0`).

## Repository layout

Private repository `0sec-labs/0security-enterprise` (name to be confirmed):

```
packages/
  license/           offline license verifier and issuer tooling
  identity-saml/     SAML provider plugin, group-to-role mapping
  scim/              SCIM endpoint for user provisioning
  rbac/              custom-role PermissionPolicy plugin
  audit-export/      webhook and SIEM sinks, retention, hash chain
  integrations/      slack, jira, ... as event-sink plugins
  service-accounts/  named CI identities with roles and rotation
docs/                customer docs, deployment guides, runbooks
compat.json          which enterprise versions work with which `0` versions
```

Releases are versioned against the open-source minor version, with a compatibility
matrix in `compat.json` checked in CI against the released `0` binary.

## Support and SLA

Mostly operational, not code: a support channel, a severity matrix with response targets,
named release channels with a security-fix policy, deployment guides and runbooks.
Targets and commitments are for Fabian (commercial) and Feza (contracts) to set.

## Build order

1. **Done:** open-source seams, one PR each: permissions, identity provider interface, audit sink,
   entitlements, plugin signature verification.
2. **Started:** the private repository `0sec-labs/0security-enterprise` exists; first package is the license issuing tool. Still open: generate the signing keys (company decision) and pin the public key.
3. Ship the first enterprise plugin the first customer actually asks for. Likely
   candidates: audit export, Slack and Jira sinks, SAML. Pick by demand, not by this list.
4. Support and release process, in parallel with step 3.

## Risks

- A seam becomes a de facto public API. Version the plugin API and keep a compatibility
  test for each seam.
- Offline licensing can be bypassed in open-source code. Accept it: sell support, the
  signed plugin channel and operational help, not DRM.
- Custom roles widen the attack surface of the permission check. Cover every seam with
  tests that the default policy matches today's behavior exactly.

## Open decisions

- Repository name (`0security-enterprise` or `0security-e`).
- Plugin packaging (A) versus in-tree build (B).
- License format and who can issue licenses.
- Which enterprise plugin ships first (customer-driven).
- Support targets and the public wording of the comparison page (Fabian and Feza).
