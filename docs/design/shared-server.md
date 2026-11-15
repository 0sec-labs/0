# Shared server: push, runners, schedules and policy

Status: proposal. Nothing here is built. It records what exists today, the gaps
found by a code audit on 2026-11-14, and a staged plan. Decisions marked
**Open** need an owner (Fabian for pricing and positioning, Doruk for engineering).

## Principle

0 stays local-first and CLI-first. Users bring their own model keys and their own
compute. The shared server **stores and coordinates; it never runs scans or
calls models**. Every server feature is a CLI command first; the web UI is a
view over the same API.

Not in scope: hosted inference, hosted sandboxes, a hosted self-serve funnel
(retired under the 2026-11-13 open-core direction), Postgres.

## What exists today (verified in code)

| Area | Today | Where |
|---|---|---|
| Schedules | Hourly/daily/weekly triggers and sentinel cron fire from a 15 s in-process poll; only while `0 web` runs; missed runs are skipped | `packages/cli/src/web/workflow-triggers.ts`, `sentinel-runner.ts` |
| Headless runs | `0 automation run` works from CI or external cron; no schedule command or daemon | `docs/src/content/docs/automations.md` |
| Results | Per-run SQLite plus `report.json`; export JSON, Markdown, HTML, SARIF, PDF; `0 reports import` loads a CI report locally | `packages/engine/src/storage`, `report-export.ts` |
| Versioned format | Only the Findings API envelope (`schemaVersion: 1`); read-only | `docs/src/content/docs/findings-api.md` |
| Teams | `0 team init`, `0 web --team-config`; owner/editor/viewer; scrypt accounts in a JSON file; OIDC; sessions in memory | `packages/cli/src/web/team-*.ts` |
| Remote engines | The console dials out to engines with a static bearer token per engine; engines never dial in | `backend-connections.ts` |
| Scope | `ScopePolicy` matcher with an injectable `opts.scope`; off unless the scope plugin is enabled | `packages/engine/src/scope` |
| Telemetry | Level defaults to `usage`; only sends to a configured cloud host (inferred, not fully verified) | `telemetry/analytics-level.ts` |

## Gaps

1. No upload path for results and no run envelope.
2. No runner identity, enrolment or heartbeat.
3. No shared store for schedules, policy or approved targets.
4. Sessions and accounts are not durable (memory and a JSON file).
5. No headless scheduler.

## Storage

Constrained by `docs/design/storage-boundaries.md`: local engine data stays in
SQLite; shared multi-machine authoritative writes are where that document says
server-owned Postgres belongs; and SQLite files must never be shared between
workers. The WASM VFS does **not** support WAL.

So the open-source server, if built, is **one process that exclusively owns one
SQLite file**. Runners never open the file; they push over HTTP and the server
serializes writes (rollback-journal mode, readers blocked during writes). That
is acceptable for tens of runners pushing run-sized batches and not beyond.
Self-hosting stays `docker run` plus a volume. Keep SQL portable so a Postgres
backend can be added for a managed or large deployment; do not build it now.
**Open:** whether enterprise scale-out is ever in scope.

**Pragmatic order: files first.** `report.json` plus `run.json` already exist,
and `0 reports import` already loads them. A versioned, redacted envelope on top
of that gives CI artifacts, S3 or git a working "sync" with no server at all. Build
the server only once real users need shared schedules, policy or a combined view.

### Storage layer: what to take from promptfoo

Both projects use `drizzle-orm` on SQLite. Differences found in code:

- **Migrations.** promptfoo generates numbered SQL files with drizzle-kit (26 in `drizzle/`). 0 declares tables in `packages/engine/src/storage/schema.ts` and hand-mirrors them as raw SQL in `schema-migrations.ts`, with ad hoc `ALTER TABLE` for old databases. Two copies drift (see issue 420). For the **server database**, use generated, numbered migrations from day one. Do not rewrite the local engine database.
- **Driver.** promptfoo uses native `@libsql/client` and imports it lazily so a missing platform binding gives a friendly error. 0 uses `node-sqlite3-wasm` behind a shim: no native binary, which suits the single-binary installer. Keep it unless the server needs something it cannot do (concurrent writers, WAL behaviour: **verify before committing**).

### Share protocol: what to take from promptfoo

From `src/share.ts`: chunked upload with retry and adaptive chunk size, **rollback of a partial upload**, config sanitising and file-path stripping before upload, a kill switch (`PROMPTFOO_DISABLE_SHARING`), and a server URL override (`PROMPTFOO_REMOTE_API_BASE_URL`). Adopt all five for `0 push`: idempotent chunks keyed by `runId`, a `--dry-run`, `ZERO_DISABLE_PUSH`, and `ZEROSEC_SERVER_URL`.

## 1. Run envelope

A versioned JSON document for one run, derived from the Findings API shape.

```
{ schemaVersion, engineVersion, runId, target, startedAt, finishedAt, status,
  findings: [ { fingerprint, severity, status, class, title, location, ... } ],
  coverage, cost, policy: { id, hash } | null }
```

- Stable identity: finding `fingerprint` plus `runId`; the server upserts, so push is idempotent.
- Redaction is an **allowlist**: only fields named in the schema are uploaded.
- Never uploaded by default: evidence requests and responses, auth headers, source snippets, agent transcripts (`agent_sessions`), `targets.systemPrompt`, stored credentials, artifact content, stderr logs.
- Opt-in per push (`--include evidence`), with a local preview (`0 push --dry-run` prints exactly what would leave the machine).

## 2. `0 server` and `0 push`

- `0 server start --db ./0-server.db` (builds on the team server); `0 server backup` copies the DB file.
- Accounts, sessions, tokens move into the server DB.
- Tokens are scoped: `push`, `runner`, `read`. Shown once, stored hashed, revocable.
- `0 login --server URL` and `ZEROSEC_SERVER_URL` select the server. `0 push [run]` uploads an envelope; `0 reports import` already covers the reverse direction locally.
- Read API: reuse the Findings API routes, plus run listing.

## 3. `0 runner` and `0 schedule`

- A runner enrols with a runner token, gets an identity, heartbeats, and **polls outward** for jobs. No inbound ports on the user's network. This differs from today's model where the console dials engines; both can coexist.
- Jobs are claimed through lease rows in one write transaction; the server expires stale leases. The runner executes with local keys and local sandboxes, then pushes the envelope.
- `0 schedule add|list|remove|enable` manages schedules stored on the server. A schedule is an automation reference plus a cadence, timezone and an approver.
- Implementation seam: `WorkflowTriggerService` takes an adapter and exposes `tick(now)`; add a remote-backed trigger source.
- Keep the existing safeguards: enabling a schedule needs review and approval, and any edit disables it again. Add missed-run catch-up as an explicit option.

## 4. Policy and approved targets

- A signed, versioned document: `{ policyId, sequence, issuedAt, expiresAt, scope, costCeilingUsd, modelAllowlist }`.
- Signature (for example Ed25519) is checked against a key pinned in the binary, with a rotation plan; cache the last-known-good copy at `~/.0/policy/` (mode 0600) and reject lower sequence numbers.
- **It can only tighten.** It may intersect scope, lower ceilings and restrict models. It must never widen anything.
- Feed it through the existing `opts.scope` seam so each run sees one pinned snapshot; record `policyId` and hash in the run and the envelope.
- Offline behaviour: use the cache until it expires, then fail closed unless the operator chooses otherwise.
- **Honest limit:** on a machine the user controls, a user can disable the scope plugin or edit local files. Policy is advisory unless enforcement is mandatory. State this in the docs. **Open:** mandatory enforcement mode for managed environments.

## 5. Telemetry and privacy

- **Open:** make analytics opt-in (or off whenever no server or cloud is configured). Today the default level is `usage`.
- Document what leaves the machine: nothing by default; with `push`, only the allowlisted envelope; with run contribution, what its terms state.

## Enterprise (later, same server)

SSO and RBAC beyond three roles, audit log, integrations (Slack, Jira, SIEM), longer retention, support. A hosted, managed deployment is possible but is a separate decision. `0cloud`'s `cloud-contracts` finding identity and Zod contracts are the reusable parts; its Postgres queue, Superserve, LiteLLM and billing are not.

## Build order

1. Add `schemaVersion` to `report.json` and `run.json` (neither carries one today; the CI import records `ciImport.schemaVersion: 1` only on the importing side), define the redaction allowlist, and add `0 reports export --share-safe` with a dry-run. No server needed; `0 reports import` is the other half and already exists.
2. `0 server` on SQLite with durable accounts and tokens, plus `push` ingest.
3. `0 runner` and `0 schedule` with lease rows.
4. Signed, tighten-only policy.
5. Docs: "Open source and Enterprise" and a privacy page, written once steps 1 and 2 exist.

## Open decisions

- Telemetry opt-in or opt-out (Doruk and Fabian).
- One open-source server with a license-gated enterprise tier, or a separate private enterprise layer (recommended: separate).
- Advisory versus mandatory policy enforcement.
- Whether enterprise scale-out (Postgres) is ever in scope.
- Free and paid column contents for the public comparison page (Fabian).
