---
title: Findings API
description: Read retained findings and evidence through workspace-scoped integration credentials.
---

The findings API lets reporting integrations read retained security findings from the selected engine. It does not launch assessments, ingest findings, run commands, or grant access to model credentials.

Create a credential in **Settings → Findings API access**. Workspace owners manage credentials in team mode; personal installations use their existing local owner control access. The credential is shown once. Store it in your integration's secret manager.

Credentials have the single scope `read:findings`. They expire after 90 days by default; owners can choose an explicit future expiry or no expiry. Revocation takes effect on the next request. Each credential belongs to its current workspace; enabling or changing team configuration selects that workspace's credential store.

Send the credential in the Authorization header:

```sh
curl --header "Authorization: Bearer $ZERO_FINDINGS_API_TOKEN" \
  "http://127.0.0.1:48123/api/v1/findings?limit=50"
```

The web engine binds to loopback. Remote integrations use the operator's authenticated reverse proxy or tunnel. Credentials are not accepted in URLs. They authorize only GET and HEAD on the following versioned routes; they cannot call the dashboard, chat, execution, administration, or credential-management APIs.

## List findings

`GET /api/v1/findings`

| Parameter | Meaning |
| --- | --- |
| `limit` | Page size from 1 to 100; default 50. |
| `cursor` | Opaque `page.nextCursor` from the previous response. |
| `scanId` | Exact source scan ID. |
| `severity` | `critical`, `high`, `medium`, `low`, or `info`. |
| `status` | A persisted finding status, such as `discovered`, `confirmed`, `verified`, or `false-positive`. |
| `includeSuppressed` | `true` to include suppressed findings; default `false`. |

The response contains `schemaVersion: 1`, `workspaceId`, `findings`, and `page: { limit, nextCursor, hasMore }`. Each entry contains `scanId`, `target`, and the canonical `finding`, including its retained evidence and available review metadata.

Rows are ordered by timestamp descending, then ID descending. Keep the same filters when advancing the cursor; a cursor is bound to the workspace, engine database and filters. This is pagination over current retained records, not a frozen assessment snapshot. Newer findings added between pages appear in a fresh listing.

## Read one finding

`GET /api/v1/findings/:id`

Use an exact finding ID. The response contains `schemaVersion`, `workspaceId`, `scanId`, `target`, and `finding`. Missing findings or missing retained source scans return 404. The API does not search other engine databases or infer verification from a confirmed finding.

## Export selected evidence

`GET /api/v1/findings/export?id=finding-a&id=finding-b`

Select between 1 and 500 distinct exact finding IDs with repeated `id` parameters. The JSON response contains `schemaVersion: 1`, `workspaceId`, `coverage: "selected-retained-findings"`, and `report`.

The report retains selected finding evidence and available review fields. It is an evidence collection, not proof of complete asset coverage. Missing selected findings fail the export rather than silently removing evidence.

## Credential management

These routes require the existing owner control transport and, in team mode, an authenticated workspace owner. Findings read credentials cannot call them.

- `GET /api/findings-access` returns redacted credential metadata.
- `POST /api/findings-access` accepts `{ name, expiresAt?, scopes? }` and returns `{ credential, token }` once. The only permitted scope is `["read:findings"]`; `expiresAt` is a future ISO timestamp or `null`.
- `DELETE /api/findings-access/:id` revokes the credential.

Persisted credential files contain hashes and metadata, never the plaintext bearer. List and revoke responses do not reveal it. Revoked credentials remain visible for auditability.
