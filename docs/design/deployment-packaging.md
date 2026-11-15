# Deployment packaging: one image, one compose file

Status: **decided** (founders, 2026-11-14); P0 (server mode, health, hardened image, compose, CI check) is built. Sections 1 to 3 are the research that led here and keep their original wording where it is still true. Claims are tagged **verified** (read from source or docs) or **inferred**.

## Goal

Anyone can try the console on a server from the open-source image. Enterprise customers get the same image, run for them or by them under a contract. We maintain one public artifact line, not a self-serve cloud plus a dedicated-computer line.

## Decisions (final)

1. **The public self-host story is one artifact: the Docker image plus one `docker-compose.yml`** (`deploy/compose/`). Single node, one replica, one volume holding the SQLite state. Documented plainly: one process owns the database, there is no HA. Labelled **experimental**.
2. **No public Helm chart and no public Terraform module.** They drift (Promptfoo's stale chart) and cost support (PostHog dropped Helm). Enterprise on-prem and vendor-managed single-tenant deployments are **by contract**, with a private enterprise image and private deployment artifacts that live in the separate enterprise repository. Nothing named `helm/` or `terraform/` is added to this repository.
3. **No hosted inference.** Customers bring their own model keys.
4. **`0 web` must run in a container behind a proxy.** Done through an explicit, off-by-default server mode (see "Server mode" below). Loopback behaviour is unchanged.
5. **Vendor-managed = the same image, run single-tenant per customer** from the enterprise repository's private artifacts, in the customer's account where possible. Self-serve multi-tenant is not offered.

Phases collapse to: **P0 is this work. The enterprise repository owns everything after it** (Kubernetes, Terraform, licence issuing, runbooks, SLAs). The former P1 (Helm) and P2 (Terraform) public phases are dropped.

## 1. What Promptfoo ships

All verified from github.com/promptfoo/promptfoo (main) and promptfoo.dev docs, except where marked.

- One MIT Node/Alpine image, `ghcr.io/promptfoo/promptfoo`, running the server behind `promptfoo view` and `share`. Non-root, `/health` check, port 3000. [Dockerfile](https://github.com/promptfoo/promptfoo/blob/main/Dockerfile)
- State is one SQLite file plus a blobs directory on one volume. Single replica only (jobs live in server memory). No built-in auth, SSO or RBAC. Docs say self-hosting is not recommended for production (re-check wording in `site/docs/usage/self-hosting.md` before quoting). [Self-hosting docs](https://www.promptfoo.dev/docs/usage/self-hosting/)
- A Helm chart exists in-tree at `helm/chart/promptfoo`: Deployment, Service, optional Ingress, HPA, PVC. It is stale (appVersion 0.54.1 vs release 0.125.1), image tag default is a placeholder, base URLs are hardcoded, and no helm CI workflow is visible. A cautionary example of drift.
- No public Terraform module and no product compose file were found (search not exhaustive).
- Release automation (release-please) publishes a multi-arch image to GHCR with attestations.
- Enterprise is closed: managed SaaS and "Enterprise On-Prem" (AWS/Azure/GCP), contact-us pricing. On-prem uses a separate non-public image, a dedicated runner, and SSO (SAML/OIDC) through FusionAuth. Setup instructions ship with the release, not in public docs. [Enterprise docs](https://www.promptfoo.dev/docs/enterprise/)
- Inferred: the enterprise product is multi-service (real database, runner, identity provider), so it is not the OSS image with a flag. Architecture, licensing and upgrade mechanics are not public.

Lesson: a thin, honest OSS single-node image; the multi-tenant, SSO and runner product is delivered with the contract. We take the image and skip the chart.

## 2. Patterns from peers

- Langfuse (verified): one codebase and image set for Cloud, Compose, Helm ([langfuse-k8s](https://langfuse.github.io/langfuse-k8s)) and Terraform ([AWS](https://github.com/langfuse/langfuse-terraform-aws), Azure, GCP). Terraform wraps Helm. Its AWS module even runs untrusted code evaluation in an isolated VPC. Dedicated infrastructure is sold as customer-operated "Self-Hosted Enterprise". Needs a funded team to sustain.
- PostHog (verified): dropped Helm in 2023 because support cost was too high for the share of users; kept Compose "hobby" with no guarantee. [Post](https://posthog.com/blog/sunsetting-helm-support-posthog). Each extra artifact has a support cost.
- Sentry and Plausible (verified): self-host is minimal Compose with little or no support; hosted and single-tenant are run by the vendor. Plausible CE ships twice a year, Cloud continuously.
- Coder and OpenHands (verified from docs, vendor claims): Helm control plane plus Terraform or per-session sandbox pods, with a separate node pool and a hardened runtime (Sysbox, gVisor, Kata) for untrusted work.
- Pattern for us (inferred): image as the contract, thin wrappers, sandboxes isolated from the control plane. Avoid a full matrix of artifacts.

## 3. Our gap list

All verified by reading origin/main (0 repo) on 2026-11-14; the image was not run. The private 0cloud repo was not audited and may hold relevant material.

Exists:
- Image `ghcr.io/0sec-labs/0security` (alias `0`), amd64 only, ENTRYPOINT `node /app/dist/0.js`, uid 1000, built by `scripts/docker/Dockerfile`, published by `.github/workflows/docker-publish.yml` (tags: SHA, `main`, `latest`; no semver, no cosign, SBOM or provenance). Docs page `/docker/` covers only one-shot `scan` runs.
- Server: `0 web` (`packages/cli/src/commands/dashboard.ts`) with team mode, scrypt accounts and OIDC, engine bearer token, caps, Findings API.
- Seams: only plugin registry signature verification (#363, `ZERO_REGISTRY_PUBLIC_KEY_FILE`) remains. The permission policy, identity provider, audit sink and entitlements seams (#359-#362) were reverted in favour of a gateway.
- State under `~/.0`; `ZERO_DB_PATH`, `ZERO_RUN_DIR`, `ZERO_TEAM_CONFIG`, `ZERO_NO_TELEMETRY`, `ZERO_OFFLINE`, `ZERO_REQUIRE_SCOPE` exist.

Missing (status after P0: items 1 to 3 and the semver part of 8 are fixed, see sections 4 and 5; items 4 to 7 remain and are documented as limits):
1. No compose file, `helm/`, `terraform/` or systemd unit anywhere.
2. `0 web` refuses non-loopback `--host`, and `authorizeWebRequest` returns 403 for any Host header other than the bound loopback host and port. The container cannot be reached with `-p`. Blocker for everything below.
3. No server CMD, no HEALTHCHECK, no `/healthz` or `/readyz` (only `GET /` and a token-gated handshake).
4. Single SQLite owner, no WAL, in-memory sessions, in-process scheduler: one replica per deployment. No crash recovery of in-flight runs.
5. No schema version table found (`migrateLegacySchema` plus ad hoc ALTER), so rollback after upgrade is unverified and probably unsafe.
6. `~/.0/credentials.json` is mode 0600 but not encrypted; console transcripts are not scrubbed.
7. Sandbox backends: SmolVM needs KVM on Linux and is qualified only on Apple Silicon; `Dockerfile.workbench` is arm64 only; the Docker backend needs a daemon the image lacks. A container-only deployment runs local execution with no VM isolation.
8. No metrics or OTLP endpoint, no backup procedure beyond copying files, no semver tags.
9. Principles on record: `shared-server.md` says do not build the server yet; `enterprise-edition.md` says no hosted inference, no hosted sandboxes. A vendor-run deployment holding customer vulnerability data needs a recorded decision.

## 4. Server mode (built)

**One artifact line: the OCI image is the product.** Compose is the only public wrapper.

`0 web --host 0.0.0.0 --server-mode` (also `ZERO_SERVER_MODE=1`) is the one switch. Without it nothing changes: loopback bind only, per-start control token injected for the local operator, Host must be the bound loopback host and port.

Flags and environment (server mode only unless noted):

| Flag | Environment | Meaning |
| --- | --- | --- |
| `--server-mode` | `ZERO_SERVER_MODE=1` | Enable everything below. Off by default. |
| `--allowed-host <name...>` | `ZERO_ALLOWED_HOSTS` | Accepted `Host` names (`name` or `name:port`). Default is only the bind host. A wildcard bind (`0.0.0.0`) with no allowed host refuses to start. Unknown Host gets 403. |
| `--trusted-proxy <cidr...>` | `ZERO_TRUSTED_PROXY` | Peer addresses (IP, CIDR or `loopback`) whose `X-Forwarded-Proto/Host/For` are honoured. Anyone else's are ignored. |
| `--public-url <url>` | `ZERO_PUBLIC_URL` | The public URL: Secure cookies, OIDC redirect origin, printed URL. Its host is added to the allowed hosts. |
| `--access-token-env <name>` | `ZERO_ACCESS_TOKEN` | The access token, 32 to 4096 characters. If absent and no team sign-in is configured, 32 random bytes are generated, stored 0600 at `$HOME/.0/access-token` and printed once on first start. |
| `--shutdown-timeout <s>` | | Drain deadline, default 20 s. |
| (always) | `--team-config` / `ZERO_TEAM_CONFIG` | Team accounts or OIDC. When configured they are the browser credential and the access token is ignored. |

### Authentication flow

1. Every browser request first passes the Host allow-list, Origin and fetch-metadata checks (`ServerModeGuard.authorize`), using the forwarded host and scheme only from a trusted proxy.
2. An anonymous visitor gets a self-contained sign-in page (no application script, no control token). Anonymous `/api/*` is 401, anonymous static files are 401. The only anonymous API exceptions are the OIDC start and callback GETs.
3. `POST /_access/login` with `{token}` (or `{userId,password}` in team mode, delegated to the existing `TeamAuth.login`). The token is compared in constant time (SHA-256 digests with `timingSafeEqual`). On success a 32-byte random session id is stored in memory and returned as `zero_access=<id>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` (plus `Secure` when the request arrived over https, or `--public-url` is https). In team mode the existing team session cookie is the session.
4. Only an authenticated `GET` for an app route receives the HTML with the control token. The control token stays per start, random, and is never logged.
5. API calls need the cookie session plus the `X-0-Control-Token` header (the synchronizer token: only the authenticated page can read it, no ambient credential carries it) plus, for mutating methods, an `Origin` that equals the effective origin or `Sec-Fetch-Site: same-origin`. Engine bearer requests keep their own path: bearer only, default-deny on every browser-only route, the privileged-routes table unchanged.
6. `POST /_access/logout` drops the session. Sessions last 12 hours and live in process memory (restart signs everyone out), capped at 1000.

### Health, readiness, shutdown

- `GET /healthz`: process is up. `GET /readyz`: 200 only when the phase is ready and the SQLite database answers (probe cached for 5 s), else 503 with `starting`, `draining` or `unavailable`. Both are unauthenticated, answer any Host (orchestrators probe by IP), and return one JSON key, `status`.
- The listener opens after services and migrations finish, so a refused connection means starting. On `SIGTERM`/`SIGINT` the phase becomes `draining` (readyz 503), the listener stops accepting, event streams end, ordinary requests finish within the deadline, services are disposed, SQLite handles are closed and the process exits 0. A failsafe exits 1 ten seconds past the deadline.
- Startup prints `ZERO_DASHBOARD_READY {"url":...,"mode":"server"}`.

### Threat model

Assets: the control token (full local control of the console, workflows and tools), model provider keys in the environment and `credentials.json`, findings data in `/data`, the engine bearer. Attacker positions and mitigations:

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Unauthenticated network visitor | No token in HTML; sign-in page only; API and assets 401; server refuses to start without a credential (team mode, or a 32+ character access token, or a generated one). | An access token holder has full console control; this is a single-trust-domain console, not per-user isolation unless team mode is used. |
| Credential guessing | Constant-time compare; per-client exponential backoff after 5 failures (cap 15 min) plus a global lock after 100 failures a minute; 429 with `Retry-After`; audit rows `access.login_failed`, `access.throttled`. | Client identity is the socket address, or the rightmost untrusted `X-Forwarded-For` hop from a trusted proxy. Behind a proxy that is not listed, all clients share one bucket (safe, but self-locking). |
| DNS rebinding and Host spoofing | Explicit allow-list; unknown Host gets 403 (`access.host_denied`); Origin must equal the effective origin. | Operators must list only names they control. |
| Spoofed `X-Forwarded-*` | Honoured only from `--trusted-proxy` peers; client IP is the rightmost untrusted hop. | A proxy that does not overwrite client-supplied forwarded headers breaks this; use the shipped Caddyfile or equivalent. |
| CSRF and login CSRF | SameSite=Strict cookie, Origin/fetch-metadata required on mutating calls and on login/logout, control token header required. | A same-site attacker (another page on the same registrable domain) is out of scope; do not share a parent domain with untrusted sites. |
| XSS stealing the control token | The existing CSP (script-src self plus hashes), `HttpOnly` session cookie. | Same as loopback: script in the console origin equals control. |
| Network eavesdropping | TLS is terminated by the proxy. Plain-HTTP exposure is unsafe: the token and cookie travel in clear. A loud warning prints when the bind is non-loopback and no trusted proxy is configured. | Nothing technical stops an operator from publishing the port directly; the compose file binds it to loopback by default. |
| Log and backup leakage | Neither token nor control token is logged; the generated access token is printed exactly once to stdout and stored 0600 (it remains in container logs: rotate by deleting the file and restarting, or set `ZERO_ACCESS_TOKEN`). Audit rows hold actions, outcomes and client address only. | `credentials.json` is plaintext (gap 6). Prefer environment keys on servers. |
| Compromised container | uid 1000, no extra capabilities requested, `no-new-privileges`, no Docker socket. Scan tooling runs locally inside the container. | A model-directed tool runs with the console's privileges inside the container; set `ZERO_REQUIRE_SCOPE=1` and egress rules on the host. |

Out of scope and not supported: multiple replicas, shared volumes, HA, shared sandboxes across customers, SAML or SCIM (enterprise plugin), rate limiting of the authenticated API.

## 5. Image, compose, CI (built)

- `scripts/docker/Dockerfile`: `EXPOSE 48123`, `HEALTHCHECK` on `/healthz`, `VOLUME /data` with `HOME=/data` (state under `/data/.0`), tini as PID 1, uid 1000, `org.opencontainers.image.*` labels, default `CMD web --host 0.0.0.0 --server-mode`; the entrypoint still takes `scan ...`. `ZERO_ALLOWED_HOSTS` defaults to `localhost,127.0.0.1`.
- `.github/workflows/docker-publish.yml`: adds `vX.Y.Z` and `X.Y` tags when the built commit carries the matching `vX.Y.Z` git tag; SHA, `main` and `latest` as before, both ghcr names.
- `deploy/compose/`: `docker-compose.yml`, `.env.example`, `Caddyfile`. One service, one named volume, loopback-published port, stop grace period 40 s, optional `proxy` profile (Caddy, automatic HTTPS) with the proxy network pre-trusted.
- `.github/workflows/docker-server.yml`: builds the image, starts it with compose-equivalent settings and runs `scripts/smoke-server-mode.mjs` (health, readiness, anonymous page has no token, bad Host 403, login, CSRF).

## 6. Not built, by decision

Self-serve multi-tenant routing, shared sandboxes across customers, inference resale, a customer-facing signup or billing system, HA or horizontal scale (needs a storage redesign that `shared-server.md` defers), any public Helm chart or Terraform module.

Isolation model (unchanged from the proposal): the control plane and tool execution share one container for a single customer who is the only tenant; stronger isolation uses separate worker computers (`0 computers`). KVM and SmolVM on Linux cloud need nested virtualisation or bare metal and an x86 workbench image (**inferred**, not promised).

Other points:
- Upgrades: pin the image tag or digest. Upgrade = back up, pull the new tag, restart; migrations run on start. There is no schema version table, so in-place rollback is unverified: restore the backup instead.
- Backup: stop the container and copy `/data`, or use the SQLite online backup (see the Docker page).
- Secrets: provider keys and the access token come from the environment or a 0600 env file, never arguments. Treat `credentials.json` as plaintext.
- SSO: OIDC through team mode. SAML and SCIM are enterprise plugins.
- Licence and audit export: the landed seams, delivered by the enterprise repository.

## 7. Enterprise and vendor-managed (by contract, separate repository)

Enterprise on-prem and vendor-managed single-tenant deployments use a private enterprise image built from the same open-source image and private deployment artifacts (Kubernetes manifests, Terraform, runbooks, licence issuing, backup drills, offboarding and data deletion, SLA text). They live in the enterprise repository, not here. Public docs mention only that they exist and are arranged by contract.

## 8. Open decisions for the owners

| Decision | Status |
| --- | --- |
| Vendor-run single-tenant deployment | Yes, contract-only, single-tenant, from the enterprise repository |
| Self-serve multi-tenant cloud | No |
| Public Helm chart and Terraform module | No |
| Hosted inference | No |
| Who holds customer data | Customer account preferred; vendor account only with a data-processing agreement and a deletion SLA |
| arm64 server image | Not until demanded; amd64 only and documented |
| Signed images, SBOM, provenance in `docker-publish.yml` | Open (not part of P0) |

## 9. Risks

- Legal and abuse: hosting offensive tooling for strangers carries abuse and liability risk. Contract customers only, with an acceptable-use clause, written authorisation of targets, named contacts and a termination right. No self-serve signup.
- Scope enforcement: `ZERO_REQUIRE_SCOPE=1` and server-side admission caps by default in every packaged form; egress rules enforced by the platform, not only the app.
- Audit: customers and the vendor both need a tamper-evident record of scans. Landed sink seam first; ship logs by default, signed export via plugin later.
- Data: vulnerability data is sensitive. Encrypted volumes, per-customer keys, no shared storage, a documented deletion path.
- Support cost (PostHog lesson): keep the public matrix at one image and one compose file; delete anything the CI does not cover.
- Unverified: OIDC redirect and Secure cookie behind real TLS with a public IdP, Linux SmolVM, sizing beyond the 2 vCPU / 4 GB minimum, and what 0cloud already holds.
