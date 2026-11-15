# Deployment packaging: one image, a Helm chart, a Terraform module

Status: **proposed** (research 2026-11-14). Nothing below is built unless the "Gap list" says it exists. Decisions marked **Open** need the owners. Claims are tagged **verified** (read from source or docs) or **inferred**.

## Goal

Anyone can self-host from the open-source image. Enterprise customers get the same artifact run for them or by them. We maintain one infrastructure line, not a self-serve cloud plus a dedicated-computer line.

## 1. What Promptfoo ships

All verified from github.com/promptfoo/promptfoo (main) and promptfoo.dev docs, except where marked.

- One MIT Node/Alpine image, `ghcr.io/promptfoo/promptfoo`, running the server behind `promptfoo view` and `share`. Non-root, `/health` check, port 3000. [Dockerfile](https://github.com/promptfoo/promptfoo/blob/main/Dockerfile)
- State is one SQLite file plus a blobs directory on one volume. Single replica only (jobs live in server memory). No built-in auth, SSO or RBAC. Docs say self-hosting is not recommended for production (re-check wording in `site/docs/usage/self-hosting.md` before quoting). [Self-hosting docs](https://www.promptfoo.dev/docs/usage/self-hosting/)
- A Helm chart exists in-tree at `helm/chart/promptfoo`: Deployment, Service, optional Ingress, HPA, PVC. It is stale (appVersion 0.54.1 vs release 0.125.1), image tag default is a placeholder, base URLs are hardcoded, and no helm CI workflow is visible. A cautionary example of drift.
- No public Terraform module and no product compose file were found (search not exhaustive).
- Release automation (release-please) publishes a multi-arch image to GHCR with attestations.
- Enterprise is closed: managed SaaS and "Enterprise On-Prem" (AWS/Azure/GCP), contact-us pricing. On-prem uses a separate non-public image, a dedicated runner, and SSO (SAML/OIDC) through FusionAuth. Setup instructions ship with the release, not in public docs. [Enterprise docs](https://www.promptfoo.dev/docs/enterprise/)
- Inferred: the enterprise product is multi-service (real database, runner, identity provider), so it is not the OSS image with a flag. Architecture, licensing and upgrade mechanics are not public.

Lesson: a thin, honest OSS single-node image plus a chart; the multi-tenant, SSO and runner product is delivered with the contract.

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
- Seams landed (#359-#363): permission policy, identity provider, audit sink, entitlements, plugin signature key. Licence verification exists (`packages/engine/src/entitlements/license.ts`) but `PINNED_LICENSE_KEYS` is empty, so it is inert.
- State under `~/.0`; `ZERO_DB_PATH`, `ZERO_RUN_DIR`, `ZERO_TEAM_CONFIG`, `ZERO_LICENSE_FILE`, `ZERO_NO_TELEMETRY`, `ZERO_OFFLINE`, `ZERO_REQUIRE_SCOPE` exist.

Missing:
1. No compose file, `helm/`, `terraform/` or systemd unit anywhere.
2. `0 web` refuses non-loopback `--host`, and `authorizeWebRequest` returns 403 for any Host header other than the bound loopback host and port. The container cannot be reached with `-p`. Blocker for everything below.
3. No server CMD, no HEALTHCHECK, no `/healthz` or `/readyz` (only `GET /` and a token-gated handshake).
4. Single SQLite owner, no WAL, in-memory sessions, in-process scheduler: one replica per deployment. No crash recovery of in-flight runs.
5. No schema version table found (`migrateLegacySchema` plus ad hoc ALTER), so rollback after upgrade is unverified and probably unsafe.
6. `~/.0/credentials.json` is mode 0600 but not encrypted; console transcripts are not scrubbed.
7. Sandbox backends: SmolVM needs KVM on Linux and is qualified only on Apple Silicon; `Dockerfile.workbench` is arm64 only; the Docker backend needs a daemon the image lacks. A container-only deployment runs local execution with no VM isolation.
8. No metrics or OTLP endpoint, no backup procedure beyond copying files, no semver tags.
9. Principles on record: `shared-server.md` says do not build the server yet; `enterprise-edition.md` says no hosted inference, no hosted sandboxes. A vendor-run deployment holding customer vulnerability data needs a recorded decision.

## 4. Recommendation

**One artifact line: the OCI image is the product.** Everything else only deploys that image.

- Compose is the supported minimal self-host form. A Helm chart and a Terraform module deploy the same image. No other packaging.
- Vendor-managed offering = the same chart or module applied once per customer in the vendor's cloud account. Single-tenant. No multi-tenant control plane, no self-serve login system. Customer-managed = the customer applies the same module in their account.
- A fleet is a list of per-customer module instances plus a runbook (state in Terraform backend), not a product.

What we explicitly do not build now: self-serve multi-tenant routing, shared sandboxes across customers, inference resale (customers bring keys, as `enterprise-edition.md` states), a customer-facing signup or billing system, HA or horizontal scale (needs a storage redesign that `shared-server.md` defers).

Isolation model (proposed):
- Control plane (`0 web`, state, secrets) is separate from execution of hacking tools. Default deployment runs local execution inside the container for the single customer, who is the only tenant, with a NetworkPolicy or security group that limits egress to the declared scope plus the model API. `ZERO_REQUIRE_SCOPE=1` by default.
- Stronger isolation: run the sandbox on separate worker VMs (the existing `0 computers` engine model) with no credentials and tight egress, or Kata or gVisor nodes in Kubernetes. Avoid mounting `docker.sock` or privileged pods in the default.
- KVM and SmolVM on Linux cloud need nested virtualisation or bare metal and an x86 workbench image; treat as **inferred**, spike before promising.

Other points:
- Upgrades: pin image by digest; semver tags and signed images first. Upgrade = stop, snapshot the volume, start the new tag. Rollback = restore the snapshot. Add a schema version table before promising in-place rollback.
- Backup: volume snapshots (cloud disk or CSI) before upgrade and nightly; document stop-and-copy for Compose. Restore drill in CI.
- Secrets: provider keys, engine token and OIDC secret come from env via a Secret, or a cloud secret store rendered to a 0600 env file. Never args. Treat `credentials.json` as plaintext; do not use it on servers.
- SSO: the landed identity provider seam plus OIDC. SAML and SCIM come as a signed enterprise plugin after the extension bridge is built (`enterprise-edition.md`, build order). No FusionAuth-like dependency.
- Licence: the landed entitlement hook. Add pinned keys and the issuing tool (private `0sec-labs/0security-enterprise`) in P3. Licence is delivered per customer as a file via `ZERO_LICENSE_FILE`. Telemetry kill switches already allow isolated installs.
- Audit: the audit sink seam is landed, and its enterprise consumer needs the plugin bridge. Until then, structured logs (`ZERO_LOG_FORMAT`) shipped to the customer's log store.

## 5. Phased plan

Sizes are engineer-time estimates (**inferred**), one engineer.

**P0: documented Compose, hardened image, health (1 to 2 weeks).**
- Add a trusted-proxy mode and a non-loopback bind in `dashboard.ts` and `dashboard-http.ts` (explicit flag, off by default, Host and Origin allowlist). Add `/healthz` and `/readyz`. Add a schema version table.
- `scripts/docker/Dockerfile`: `serve` default for a server target, HEALTHCHECK, documented volume at `/home/ubuntu/.0`, semver tags, cosign signature, SBOM and provenance in `docker-publish.yml`.
- Add `deploy/compose/compose.yml` (init, restart policy, stop grace period, volume, Caddy for TLS) and `docs/src/content/docs/self-hosting.md`.
- CI: `docker compose up --wait` plus health curl and a restart-persistence check in a new `deploy-e2e.yml`.

**P1: Helm chart (1 to 2 weeks after P0).**
- `helm/zero/`: StatefulSet (replicas 1, PVC), Service, optional Ingress, Secret and values schema (`values.schema.json`), probes, preStop, securityContext (uid 1000, fsGroup), NetworkPolicy, image pinned by digest. Publish as an OCI chart on GHCR.
- Docs: `docs/src/content/docs/self-hosting-kubernetes.md`.
- CI: `helm lint`, `helm template` with kubeconform, then a kind cluster install, health check, pod restart and upgrade test. Chart version tied to the app release so it cannot drift (the Promptfoo failure).

**P2: Terraform modules (2 to 3 weeks).**
- `terraform/modules/vm/` (one VM, data disk, security group on 443, DNS, ACME TLS, secret store, snapshot schedule, runs the Compose artifact by digest) and `terraform/modules/kubernetes/` (a thin wrapper that installs the P1 chart on an existing cluster; do not create clusters). Start with one cloud (**Open**: AWS recommended). `terraform/examples/`. Docs: `docs/src/content/docs/self-hosting-terraform.md`.
- CI: `terraform fmt -check`, `terraform validate`, `tflint`, `checkov` or `trivy config`. A plan against a mocked provider; apply only in a manual workflow against a test account.

**P3: managed dedicated deployment runbook and automation (3 to 4 weeks, only after the first signed customer).**
- Private repo (`0sec-labs/0security-enterprise` or 0cloud), not this one: per-customer module instances, licence issuing with pinned keys, upgrade and rollback runbook, backup restore drill, monitoring, incident and offboarding (data deletion) procedure, SLA text. Public docs list only what exists.

**Later, optional: hosted inference.** A model proxy with per-customer budgets. Reconsider only if customers ask; it conflicts with the current "bring your own keys" principle.

## 6. Open decisions for the owners

| Decision | Recommended default |
| --- | --- |
| Offer a vendor-run dedicated deployment at all | Yes, contract-only, single-tenant, after P2; record the decision because `shared-server.md` and `enterprise-edition.md` currently say otherwise |
| Self-serve multi-tenant cloud | No |
| First cloud for Terraform | AWS, one region pair |
| Who holds customer data | Customer account preferred; vendor account only with a data-processing agreement and a deletion SLA |
| Default sandbox | Local execution with egress limits and mandatory scope; worker VMs for stronger isolation |
| Helm versus Compose as the primary doc path | Compose first, Helm when the first customer asks for Kubernetes |
| arm64 server image | Not until demanded; amd64 only and documented |
| Public Helm chart and Terraform module | Public, MIT like the image, with no support promise for community use |

## 7. Risks

- Legal and abuse: hosting offensive tooling for strangers carries abuse and liability risk. Contract customers only, with an acceptable-use clause, written authorisation of targets, named contacts and a termination right. No self-serve signup.
- Scope enforcement: `ZERO_REQUIRE_SCOPE=1` and server-side admission caps by default in every packaged form; egress rules enforced by the platform, not only the app.
- Audit: customers and the vendor both need a tamper-evident record of scans. Landed sink seam first; ship logs by default, signed export via plugin later.
- Data: vulnerability data is sensitive. Encrypted volumes, per-customer keys, no shared storage, a documented deletion path.
- Support cost (PostHog lesson): keep the matrix at one image, one chart, one VM module; delete anything the CI does not cover.
- Unverified: container run of `0 web` behind a Host-rewriting proxy, OIDC redirect and Secure cookie behind TLS, Linux SmolVM, sizing (start 4 vCPU, 16 GB, 100 GB SSD, inferred), and what 0cloud already holds.
