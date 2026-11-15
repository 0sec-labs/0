# GitHub pull request integration: Action, polling, webhook, App

Status: the Action, the polling trigger, the phase 0 audit (section 4) and the phase 1 webhook receiver (section 9) are shipped. The per-instance GitHub App is not built and needs an owner decision (section 7).

## Question

Should we add a GitHub App or a webhook receiver, and how do Promptfoo and similar tools do pull request integration? Constraints: one Docker image for self-hosting (experimental, single node, no public Helm or Terraform, no hosted component); enterprise on-prem by contract from a private repo; no hosted inference.

## 1. How Promptfoo does it

Evidence is from public docs pages, not from the action source.

- Two Actions run in the user's own CI. `promptfoo-action` runs evals and posts one PR comment (`contents: read`, `pull-requests: write`). `code-scan-action` posts PR review comments and can write SARIF (`security-events: write`).
- The "Promptfoo Scanner" GitHub App is an installer. It opens a setup PR that adds `.github/workflows/promptfoo-code-scan.yml`. Auth is then GitHub OIDC with no stored key. The manual path uses a `PROMPTFOO_API_KEY` secret and `GITHUB_TOKEN`.
- The scan backend is hosted (`api-host`, default api.promptfoo.app). The self-host server is a results viewer with no PR integration, no SSO and no production support. Enterprise On-Prem is a contract tier.
- Forks are off by default. A maintainer can comment `@promptfoo-scanner` or set `enable-fork-prs`.
- Hardening advice in their docs: pin actions to full SHAs, keep the scan job apart from untrusted build steps, exact CLI version pin.
- Unknown: what the App's webhook handling does, and what code is sent to the API.

Links: promptfoo.dev/docs/code-scanning/github-action/, promptfoo.dev/docs/integrations/github-action/, github.com/promptfoo/promptfoo-action.

## 2. Peers

| Project | PR mechanism | Self-host setup | Hosted and self-hosted same path | Output |
| --- | --- | --- | --- | --- |
| Promptfoo | Action; App only installs the workflow | Workflow plus API key | Same Action; scan backend hosted or enterprise | PR comment, review comments, SARIF |
| Renovate | Cron job with PAT or own App token; webhooks only in closed Mend CE/EE | Token plus schedule | Same engine (inferred) | PRs, issues, status checks |
| PR-Agent | Action, Docker webhook server as App, or Lambda | Register App by hand, public HTTPS, webhook secret | One codebase; hosted Qodo unverified | PR comments |
| Semgrep | CI job scans; hosted `semgrep-app` posts comments | No self-hosted server | No: hosted App is a separate product | PR comments, merge blocking |
| reviewdog | CI job; optional hosted App | `GITHUB_TOKEN` or PAT | Same binary | Check runs, review comments, annotations |
| Danger JS | CI job | `GITHUB_TOKEN` or bot account for forks | Same | PR comment |
| Probot apps | Webhook server; App created by manifest flow | Setup mode writes `.env` | n/a | Anything |
| Argo CD | Polls every 3 min; optional webhook as accelerator | Webhook secret in a Secret | Same | Refresh trigger |

Unfetched and general knowledge only: Trivy, Gitleaks, CodeRabbit, Sourcery, Jenkins Branch Source.

## 3. Dominant patterns and why

1. Action first. No registration, no inbound network, a per-job least-privilege token. Costs: fork PRs get a read-only token, and results live in GitHub. This is the default for open-source security tools.
2. Self-registered App plus webhook server (PR-Agent, Probot, Mend CE). Native comments and check runs and fork support, but it needs a public HTTPS endpoint, private-key storage and signature checks. Vendors keep this for the hosted product or an enterprise add-on.
3. Poll with optional webhook accelerator (Renovate, Argo CD). Works with no public endpoint and degrades gracefully. Argo CD treats unsigned events as untrusted hints that only trigger a refresh.
4. Hosted vendor App for one-click onboarding. We rule this out (section 5).

Fork pitfalls documented by GitHub Security Lab: `pull_request_target` has secrets and write access even for forks, so checking out PR code there is dangerous. The safe split is an unprivileged `pull_request` run that uploads artifacts, then a privileged `workflow_run` job that treats the artifacts as untrusted.

## 4. Our current state

| Capability | Mechanism | Where |
| --- | --- | --- |
| CI review, audit, scan | Composite Action, checksum-verified release, `diff-base` support | `action.yml`, `scripts/run-github-action.sh` |
| Gate | Severity threshold; nonzero CLI exit fails | `scripts/render-github-action-output.mjs` |
| Outputs | `report.json`, `report.sarif`, share-safe `report.share.json`, `comment-body`, job summary | `action.yml` |
| Sticky PR comment | Docs recipe in a separate job; the Action never posts | `docs/src/content/docs/ci/github-action.md` |
| Inline suggestions | `suggest` action, one review with suggestion blocks, cap 20, skips fork PRs | `suggest/action.yml`, `scripts/post-github-suggestions.mjs` |
| SARIF upload | User adds `codeql-action/upload-sarif`; private repos need Code Security | docs only |
| Fork safety in CI | Docs gate on same-repo; `public-pr.yml` is an inert `pull_request_target` job | `.github/workflows/public-pr.yml` |
| Agent `github-pr` trigger | Polls `gh pr list` (50 PRs, per-trigger `pollMs`, 15 s tick); head-SHA cursor; first poll baselines; launch cap | `packages/cli/src/web/sentinel-runner.ts` |
| GitHub auth | `gh` device flow; never reads or stores the token | `packages/cli/src/web/github-auth.ts` |
| Publish fixes | `PrEmitter` forks a branch and runs `gh pr create` | `packages/engine/src/emit/pr-emitter.ts` |
| Webhook receiver | Server mode only, accelerator for the `github-pr` trigger (section 9) | `packages/cli/src/web/github-webhook.ts` |
| Check runs, manifest flow | None (grep found no `check-runs`, `app-manifests`) | n/a |

Phase 0 audit, verified with a fake `gh` on PATH, a temp HOME and database and a mock model (`scripts/pr-agent.e2e.mjs`, `pnpm test:pr-agent-e2e`):

| Question | Before phase 0 | Now |
| --- | --- | --- |
| What does a polled run post to GitHub? | Nothing. The run only created a thread and an activation on the Agent. No `gh pr comment`, review or `gh api` call was ever made. | Still nothing by default. Trigger option `commentOnPr` (UI "Comment on the pull request", CLI `--comment`, default off) posts one share-safe summary comment per Agent and pull request, edited in place through a hidden marker, rate limited to 1 per pull request per minute and 30 per hour. |
| Did it check out or execute fork code? | The runner never cloned or checked out anything. But a fork was treated like any pull request: it launched a normal run with the Agent's own autonomy and tools, only labelled `fork: yes` in the event. | Forks are skipped and recorded (`fork pull request`). With `includeForks` the run is forced to recon mode with GET-only requests, gets the diff through `gh pr diff`, is told it is untrusted, and its activation and comment say so. |
| Drafts, closed, merged | Drafts launched like any pull request. `--state open` kept closed and merged out. | Drafts are skipped and recorded once per head SHA and reviewed once when marked ready. Closed and merged are ignored, also if `gh` returns them. |
| Re-push | A new head SHA launched a new run. | Unchanged, and the comment is edited in place. |

Limits that remain: recon mode is a capability gate in the console, not a process sandbox, and the process environment is not stripped for fork runs. The Agent's `gh` account posts the comment, so it shows as that user. Share-safe fields are the allowlist from `share-safe.ts` (no evidence, PoC steps or paths); titles are further stripped of links, markup and mentions.

## 5. Recommendation

Principle: one code path. The Action stays the primary PR-time path. Everything below only changes how a run is triggered or where results are shown.

1. Keep the Action as the primary PR-time path and keep polling as the zero-config default. Do nothing for users who do not expose a public URL.
2. Add an authenticated webhook receiver for server mode only. It is an accelerator, not a requirement: if it is unreachable or disabled, polling keeps working.
   - `POST /api/webhooks/github` (shipped path; the proposal said `/api/github/webhook`), mounted outside the session auth, rate-limited per source.
   - Read the raw body with a size cap (default 1 MB), verify `X-Hub-Signature-256` (HMAC-SHA256 over the raw bytes, `sha256=` prefix) with `crypto.timingSafeEqual` before any JSON parsing. Reject the legacy SHA1 header.
   - Replay protection: dedupe on `X-GitHub-Delivery` in a bounded store with a TTL. Answer 2xx fast and launch asynchronously.
   - Event allow-list: `pull_request` with `opened`, `synchronize`, `reopened`, `ready_for_review`; `ping` for setup. Everything else is 204. Map into the same event shape and `launch` call the poller uses (repo, pr, headSha, base, head, fork, title, url).
   - Per-instance secret generated on first start, shown once in Settings, stored hashed-or-0600 in the state volume. Rotation from Settings. No secret means the route returns 404.
   - Audit events for accepted, rejected-signature, duplicate and over-limit deliveries (no payload bodies).
3. Optionally, a per-instance GitHub App through the manifest flow.
   - One click in Settings posts the manifest to `github.com/settings/apps/new` (or the org URL) with a `state` value bound to the session. The redirect carries a temporary code; the server converts it within the 1 hour limit and receives `id`, `pem` and `webhook_secret`.
   - Private key stored with mode 0600 in the state volume, never returned by the API or logged. Installation tokens are minted on demand (JWT, then installation token, about 1 hour) and never persisted.
   - Minimum permissions: contents read, pull requests read and write, checks write, metadata read. Events: `pull_request`.
   - The App is what allows check runs. The `gh` user path cannot create them.
4. Outputs, in this order of effort: PR comment summary (sticky, one per PR); review comments only for high-confidence findings (reuse the `suggest` rules: diff lines only, skip if head moved, dedupe, cap); a check run with annotations from the App (annotation cap applies, link to the full report); SARIF upload remains an Action step because it needs `security-events: write` on the workflow token.
5. Fork PR safety rules:
   - Never run untrusted PR code with secrets or write tokens.
   - Fork PRs get read-only analysis: fetch the diff and files through the API or a no-credential checkout, no build, no install, no test execution.
   - Never use `pull_request_target` with a checkout of PR code. If forks need comments from Actions, use the `pull_request` then `workflow_run` split and validate artifacts (for example the PR number is an integer).
   - Fork results are share-safe reports only: no evidence, PoC or secrets in comments, annotations or SARIF.
   - Maintainer trigger for forks (label or comment by a user with write access) is opt-in; a push after labelling re-requires approval.

What we do NOT do: no vendor-hosted App, no shared webhook relay, no hosted inference. Users who cannot expose an endpoint use the Action or polling, or a tunnel they run themselves. Enterprise on-prem gets the same receiver and App code from the private repo under contract.

## 6. Phased plan

| Phase | Work | Size | Files |
| --- | --- | --- | --- |
| 0 | Audit gaps: what the polled run posts back, fork checkout behavior. Done: see section 4 | S | `packages/cli/src/web/sentinel-runner.ts`, `repository-review` template |
| 1 (done) | Webhook receiver with verification, dedupe, allow-list, caps, audit | M | new `packages/cli/src/web/github-webhook.ts`, wire in `dashboard-http.ts` |
| 1 (done) | Route exemption from session auth, tests for exemption and rate limit | S | `packages/cli/src/web/privileged-routes.ts`, `privileged-routes.test.ts` |
| 1 (done) | Secret generation, rotate, show once; card on Agents and Settings > Git, CLI `0 agents webhook` | M | `packages/web/src/components/console-control/github-webhook-control.tsx`, `packages/cli/src/commands/sentinels.ts` |
| 1 (done) | Unit tests plus `scripts/webhook.e2e.mjs` (`pnpm test:webhook-e2e`, in the browser/smoke CI job) | S | `packages/cli/src/web/github-webhook.test.ts` |
| 1 (done) | Docs: server-mode guide, Agents page, changelog | S | `docs/src/content/docs/docker.md`, `docs/design/shared-server.md`, `docs/design/security-workflows.md` line about no webhooks |
| 2 | Manifest flow, key storage, installation tokens | L | new `packages/cli/src/web/github-app.ts`, Settings card |
| 2 | PR comment and review comments from the App | M | extend `packages/engine/src/emit`, reuse `scripts/post-github-suggestions.mjs` rules |
| 3 | Check run with annotations | M | `github-app.ts` |
| 3 | Action input `upload-sarif`, docs on SHA pinning and fork recipe | S | `action.yml`, `docs/src/content/docs/ci/github-action.md` |

Phase 1 gives instant events for server mode with no new GitHub permission. Stop there unless users ask for check runs.

## 7. Open decisions

| Decision | Recommended default |
| --- | --- |
| Build the webhook receiver at all | Decided and built: server mode only, 404 until a secret exists |
| Build the per-instance App | Defer until phase 1 is used; then yes via manifest flow |
| Receiver path | Decided: `/api/webhooks/github`, outside `/api/console` |
| Fork PRs | Read-only analysis, comments only from share-safe reports |
| Check runs | App only, phase 3 |
| Auto-upload SARIF in the Action | Opt-in input, off by default |
| Hosted relay for users behind NAT | No; document a self-run tunnel |
| Default delivery dedupe TTL and body cap | Decided: 24 hours (in memory), 1 MB |

## 8. Risks

- A public endpoint is new attack surface. Mitigation: verification before parsing, caps, rate limit, off by default, no PR code execution on receipt.
- A mis-mounted route could skip auth entirely. Mitigation: explicit exemption test that only this path is open and only for POST.
- Private key theft from the state volume. Mitigation: 0600, no API read, excluded from backups and support bundles, rotation.
- Polling and webhook can launch the same run twice. Mitigation: shared head-SHA cursor for both.
- Webhook delivery is not guaranteed. Mitigation: polling stays on as the backstop.
- Fork code execution through the agent run. Closed in phase 0 for the polling path: forks are skipped unless opted in, then read-only (section 4). The webhook path must reuse the same launch options.
- Research limits: peer facts come from docs summaries, not source. Re-check permission lists against GitHub docs before copying.

## 9. Phase 1 as built: webhook receiver

Scope: an accelerator for the Agent `github-pr` trigger in server mode. Polling is unchanged and stays the zero-config default and the fallback. No new GitHub permission, no App.

### Design

- **Route.** `POST /api/webhooks/github`, mounted only when the server runs with `--server-mode`. Otherwise the route does not exist: an authenticated request gets the normal 404 and an anonymous one the usual control-token refusal. With no secret yet, the route answers 404 to everyone.
- **Where it sits.** In `packages/cli/src/commands/dashboard.ts` it is handled after the Host/Origin/forwarded-header guard and before the session gate, the control-token check and every other `/api` handler. Exactly one path is exempt (`ANONYMOUS_API_EXEMPTIONS` in `privileged-routes.ts`, exact match, with a test that neighbours such as a trailing slash or `/api/console/github/webhook` still need sign-in). The engine bearer is ignored by the handler and the path stays browser-only in `isBrowserOnlyRoute`, so the bearer is no credential for it.
- **Order of checks, always before any JSON parsing.** secret exists (else 404) -> POST only (405) -> per-source rate limit (429) -> `Content-Type: application/json` (415) -> `Content-Length` over 1 MB (413) -> signature header shape `sha256=<64 hex>` (401) -> body read with a streaming 1 MB cap and a 10 s deadline (413/408) -> HMAC-SHA256 of the raw bytes with `crypto.timingSafeEqual` over equal-length digests, against the current secret and, during rotation, the previous one (401, empty body) -> global cap on verified deliveries (429) -> `X-GitHub-Delivery` dedupe -> event allow-list -> JSON parse -> payload shape. The legacy SHA-1 header is never read.
- **Allow-list.** `pull_request` with `opened`, `reopened`, `synchronize`, `ready_for_review`, and `ping`. Every other event or action, and a pull request that is not open or is merged, is acknowledged with 202 and recorded as ignored.
- **Same code path.** Payload fields only locate triggers: repository full name (case-insensitive) and base branch against enabled `github-pr` triggers. Nothing in the payload authorizes anything or reaches a run. For each match the receiver calls the poller's own `checkNow` routine, which lists pull requests through `gh`, applies the draft, fork, closed, comment and baseline rules, advances the per-pull-request head-SHA cursor and launches. The webhook therefore cannot launch a fork or draft the poller would skip, and one head SHA launches once whichever path sees it first. The reply is 202 right after verification; the checks run afterwards.
- **Replay and dedupe.** Delivery ids are remembered in an in-memory insertion-ordered map, 24 hour TTL, 5,000 entries at most, only after the signature verified, so an unsigned request cannot burn an id. A restart forgets them. That is acceptable because the durable defense is the head-SHA cursor: a replayed signed delivery can only cause one extra check, never a second launch. Disk persistence was rejected as more state for no safety gain.
- **Rate limits.** 30 requests per minute per source (the client address after trusted-proxy resolution), applied before any hashing; 300 verified deliveries per minute globally. The global cap counts only verified deliveries, so anonymous traffic cannot starve GitHub.
- **Secret.** 32 random bytes as hex in `github-webhook-secret.json` in the state directory, mode 0600, written atomically, created on first enable. Created and rotated from `POST /api/console/github/webhook/secret[/rotate]` (browser-only, owner in team mode, audited). The value is returned once by those two calls and by nothing else; status never includes it. Rotation keeps the previous secret for 5 minutes, then drops it.
- **Observability.** Audit events `webhook.received`, `webhook.ignored`, `webhook.rejected` carry the event name, a reason code and the client address, never payload content, headers, delivery ids, the secret or the signature (the audit store also whitelists keys). The Settings card and `0 agents webhook status` show the last 5 outcomes from memory; the audit log is the persistent record. Logs do not include either value.
- **Surfaces.** Card **GitHub webhook** on Agents and Settings > Git, rendered only in server mode; CLI `0 agents webhook status` and `0 agents webhook secret rotate --yes` (hidden command, so not in the generated command reference).

### Threat model

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Forged delivery from anyone on the internet | HMAC-SHA256 over the raw body with a 256-bit secret, constant-time compare, checked before parsing; bare 401 | Secret theft equals forgery; see rotation |
| Attacker learns that the endpoint exists | Unavoidable once public; 404 until a secret exists; no detail in errors | Anyone can send junk and is rate limited |
| Timing oracle on the signature | `timingSafeEqual` on equal-length digests; shape checked first; all candidate secrets evaluated | None known |
| Replay of a captured signed delivery | Delivery-id dedupe (24 h) and the head-SHA cursor | After a restart or past 24 h a replay costs one extra `gh` check, never a second review |
| Oversize or slow body (memory, CPU) | 1 MB cap by `Content-Length` and while streaming, 10 s deadline, per-source rate limit before hashing, connection closed on 413 | A distributed flood is bounded by the proxy and the OS, not here |
| Starving real deliveries with junk | Global cap counts only verified deliveries; per-source limit | Many sources can still exhaust the proxy |
| Payload steers the Agent (prompt injection, forced fork review) | Payload only locates triggers; the run input comes from `gh` through the poller routine; fork, draft and closed rules are the poller's | Content of pull requests stays untrusted data, as for polling |
| Route leaks session or control authority | One exact-path exemption, tested; handler ignores cookies, the control token and the engine bearer | A future edit that widens the exemption must fail `privileged-routes.test.ts` and the e2e |
| Engine bearer used against the route or its settings | Bearer ignored by the route; settings routes are browser-only (default deny) | None |
| Secret exposure | 0600 file, returned once, never in status, audit or logs, not in the query cache; rotation with 5 minute grace | Anyone who can read the state volume can read it, as with the access token |
| Wrong client address behind a proxy | Rightmost untrusted `X-Forwarded-For` hop, only from `--trusted-proxy` | Without a trusted proxy all senders look like the proxy and share one limit |
| Webhook down or unreachable | Polling is unchanged | Reviews wait for the next poll |
| `gh` read lag right after a push | Next poll catches it | One poll interval of delay in rare cases |

### Decisions

- Receiver path `/api/webhooks/github`, not `/api/github/webhook`, so it never shares a prefix with the console routes.
- The webhook calls the existing check routine instead of building a PR event from the payload. This costs one `gh pr list` per delivery and removes a second path with its own fork and draft rules.
- In-memory dedupe, no persistence; restart semantics documented above.
- Secret lives in its own file, not in the control database, next to the access token.
- Not verified here: a real GitHub delivery. Tests and the e2e send correctly signed samples in GitHub's documented format.
