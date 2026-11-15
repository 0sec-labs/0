# Enterprise edition: a private repo on top of the open-source engine

Status: proposal (2026-11-15). Nothing here is built. Facts below were read from
the code on `main`; open decisions are listed at the end. No prices appear here.

## Principles

- **Open core.** Everything that exists in `0` today stays open source. Enterprise
  adds capabilities; it never removes or degrades an open-source one.
- **Bring your own keys and compute.** No hosted inference, no hosted sandboxes,
  no self-serve multi-tenant service. Enterprise features run on the customer's own
  machines and servers. Vendor-managed single-tenant deployments (the same image
  run for one customer, in their account where possible) are in scope **by contract**,
  with a private enterprise image and private deployment artifacts in the enterprise
  repository (`deployment-packaging.md`).
- **Same `0` command.** Customers keep using the open-source `0` CLI and engine. Enterprise is a
  separate gateway that sits in front of the engine, not a fork.
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

## Seams that exist in the open-source code (see the gateway decision below)

- **Event sinks.** `packages/engine/src/events/bus.ts` has an `EventSink` interface and
  `eventBus.subscribe(sink)`. Sinks are added at runtime, fan-out is defensive (a
  throwing sink never aborts a scan). Slack, Jira and SIEM forwarding fit here.
- **Plugins.** The plugin system loads fingerprint-approved, sandboxed, permission-gated
  executable plugins that speak newline-delimited JSON over stdio, plus MCP-server
  plugins. `ZERO_REGISTRY_URL` points the CLI at another registry index.
- **Scope injection.** The scanner already accepts an in-memory scope.

## Seams added to the open-source engine (superseded by the gateway decision below)

All five landed as separate PRs with no behavior change by default (2026-11-15). The gateway decision below means
most are not needed; the table there says which to keep.

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

## How enterprise attaches to the engine: a gateway, like promptfoo (decision 2026-11-15)

An earlier version of this section proposed extending the plugin protocol with hooks and building an
in-engine bridge. That is more machinery than needed, and promptfoo shows the simpler shape.

What promptfoo does (read from its open-source repository): the open-source code contains **no** SAML, SCIM,
RBAC, audit-log, Slack or Jira code. Its CLI is a *client* of a separate closed server: `promptfoo auth login
--host <url>` or an API key, then `share` pushes results. SSO, roles, audit logging, service accounts and
integrations all live in that closed server (hosted, or on-prem for customers). There is no plugin protocol and
no in-process hook for enterprise features.

What that means for us:

```
 users --SSO/SAML--> [ Enterprise gateway ] --HTTP--> [ open-source 0 engine ]   (unchanged)
                      closed, private repo              Findings API, console API,
                      roles, audit, SCIM,               remote engines, team workspace
                      Slack/Jira/SIEM
```

- The **enterprise gateway** is a closed service in `0sec-labs/0security-enterprise`. It sits in front of the
  unchanged open-source engine, which already documents running behind "your own authenticated reverse proxy"
  (`findings-api.md`) and already speaks HTTP to remote engines (`backend-connections.ts`, bearer token).
- The gateway owns SSO and SAML, SCIM, custom roles, the audit trail, service accounts and notifications. It
  calls the engine's existing API; the engine needs no knowledge of the gateway.
- Integrations (Slack, Jira, SIEM) read findings through the engine API (poll the Findings API for new findings)
  and run inside the gateway, not inside the engine.
- Customers run both on their own infrastructure (container images from a private registry). No hosting by us, no
  model keys held by us. This is promptfoo's "on-prem" shape.
- The licence check lives in the gateway. The open-source engine never needs to know about licences.

### What this does to the seams already merged

The five seams (#359 to #363) were built before checking this. With the gateway approach:

| Seam | Still useful? |
|---|---|
| Registry signature verification (#363) | Yes. Independent supply-chain hardening for the public plugin registry |
| Named permissions and policy (#359) | Harmless refactor; not needed by the gateway. Keep unless it becomes a maintenance cost |
| Identity provider interface (#360) | Not needed by the gateway. Keep unless it becomes a maintenance cost |
| Audit sink (#361) | Not needed by the gateway. Keep unless it becomes a maintenance cost |
| Entitlements (#362) | Not needed in the open-source engine. The licence check belongs in the gateway |

None change default behavior. Do not build the plugin hooks protocol or the extension bridge.

### Work this implies

1. Confirm the engine API covers what the gateway needs: list findings, read evidence, start runs, read run status, and a
   way to learn about new findings (poll the Findings API). Fill gaps in the open-source API only where the gap is generic.
2. Build the gateway in the private repository: authentication in front of the engine, then roles, then audit, then one
   integration. Pick the first by customer demand.
3. Package both as containers with a compose file for on-prem.

## Repository layout

Private repository `0sec-labs/0security-enterprise` (name to be confirmed):

```
gateway/             the closed service in front of the open-source engine: auth, roles, audit
packages/
  license/           offline licence verifier and issuing tool
  sso/               OIDC and SAML sign-in, group-to-role mapping
  scim/              user provisioning endpoint
  integrations/      Slack, Jira, SIEM; read findings through the engine API
deploy/              container images and a compose file for on-prem
docs/                customer docs, deployment guides, runbooks
compat.json          which gateway versions work with which `0` engine versions
```

Gateway releases are versioned against the open-source minor version, with a compatibility matrix in
`compat.json` checked in CI against the released `0` engine.

## Support and SLA

Mostly operational, not code: a support channel, a severity matrix with response targets,
named release channels with a security-fix policy, deployment guides and runbooks.
Targets and commitments are for Fabian (commercial) and Feza (contracts) to set.

## Build order

1. **Done:** the five open-source seams (see the table above for which are still useful) and the private repository.
2. Confirm the engine API covers the gateway's needs; fill only generic gaps in the open-source API.
3. Build the gateway skeleton: authenticate in front of the engine, then roles, then audit. Ship the first
   integration the first customer asks for (candidates: Slack or Jira notifications, SAML), picked by demand.
4. Container packaging and an on-prem guide. Support and release process in parallel.
5. Generate the licence signing key (company decision) when the gateway first needs a licence check.

## Risks

- The gateway depends on the engine's HTTP API. Treat the endpoints it uses as a versioned contract with
  a compatibility test in CI.
- Offline licensing can be bypassed in open-source code. Accept it: sell support, the
  signed plugin channel and operational help, not DRM.
- A gateway in front of the engine is a security boundary. The engine must keep binding to loopback or a private
  network so it cannot be reached around the gateway.

## Open decisions

- Repository name (`0security-enterprise` or `0security-e`).
- Licence format and who can issue licences (needed once the gateway has a licence check).
- Which enterprise plugin ships first (customer-driven).
- Support targets and the public wording of the comparison page (Fabian and Feza).
