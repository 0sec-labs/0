# Platform cleanup and migration checklist

> Status: 2026-10-28. Checked items describe verified workspace work, not a merge to either repository's main branch.

## What lives where

| Area | Location | Current state |
| --- | --- | --- |
| Public engine and production analysis | `0/packages/core`, `0/packages/cli` | Retained; local SQLite and existing private transcript/lesson stores |
| Shipped decoder fixture | `0/assets/worker-demo/demo-target` | Extracted from research; build/export/deployment paths updated in working tree |
| Standalone experiments and papers | `0cloud/research/engine-experiments` | Copied and adapted; source pushed on `cleanup/engine-research-only-20261028` |
| Wireless campaign and remaining source | `0cloud/research/apple-wireless-2026-10` | Existing files preserved; missing source pushed; full working data verified locally |
| Credentials, generated worker configuration and bulk datasets | Private `0cloud` working files | Local-only and excluded from migration commit; not uploaded by this migration |
| Hosted product state | `0cloud` control plane | Existing Postgres; cloud runner remains independent of the public engine |

Private migration commit: `a5c4df5c08382883c4c219ba3a9ec31821b7dbf2`.
The public checkout no longer has a top-level `research/` directory. Its deletions
and fixture extraction are still uncommitted alongside existing unrelated work.

## Finish bringing the research over

- [x] Inventory runtime consumers before removing standalone research.
- [x] Verify copies of 77 experiment files and 140 wireless working files.
- [x] Preserve existing private files instead of overwriting them.
- [x] Require `ZERO_ENGINE_ROOT` for engine-dependent private demos.
- [x] Remove automatic credential-file loading from the retained remote demo.
- [x] Move shipped assets out of research and remove the public research folder.
- [x] Push one isolated migration commit on the clean private branch.
- [ ] Review and merge the clean private migration branch into `0cloud/main`.
- [ ] Commit the public removal and fixture/build/export updates as a focused change, preserving unrelated workspace edits.
- [ ] Verify a clean public checkout builds/exports using only the shipped fixture.
- [ ] Choose durable private artifact storage for local-only bulk data; upload with the SHA-256 manifest and verify retrieval before deleting any local copy.
- [ ] Review the old generated worker token and rotate/revoke it if active. Moving/deleting a file does not remove prior public Git history.
- [ ] Review the superseded `cleanup/private-engine-research-20261028` branch separately; it inherited pre-existing local cloud commits. Do not merge it as the migration PR or delete it without approval.

## CLI and agent onboarding

- [ ] Publish a verified CLI/web capability matrix; do not claim complete parity from shared backend code alone.
- [ ] Test freshly built local CLI artifacts with isolated home/workspace and loopback fixtures.
- [ ] Test current cloud CLI onboarding, structured success/errors, authentication and permission failures against a loopback mock.
- [ ] Provide deterministic CLI access to admitted web-backend API operations without duplicating business logic.
- [ ] Verify sessions, worker control, workflows, schedules, skills, memory and settings operations; record remaining browser-only/auth steps.
- [ ] Document exact setup, capability discovery, structured output, polling, cancellation and exit-code behavior for agents.

## Storage and execution boundaries

- [x] Keep local SQLite and hosted Postgres as separate deployment choices.
- [x] Remove unsafe automatic database-open repair and preserve WAL/lock data.
- [x] Create new ordinary local database files owner-only on Node and Bun.
- [x] Fix source-note multiwriter loss and crash-tail appends.
- [x] Use shared source-recall and conversation-search policies.
- [x] Remove ineffective synchronous-read batching.
- [ ] Keep same-session stateful actions ordered; do not advertise arbitrary tool concurrency.
- [ ] If moving local records into a common SQLite schema, implement a versioned migration/rollback and deletion tests first; do not add Postgres or a memory framework just to rename the current stores.

## Appearance

- [ ] Verify the served build exposes Settings → Appearance → Theme.
- [ ] Test Dark/Light persistence across reload and new chat; distinguish onboarding/site styling from the application theme.
- [ ] Check the running artifact against current source before diagnosing forced light mode.
