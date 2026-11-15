---
title: Findings API
description: Read retained findings and evidence through workspace-scoped integration credentials.
---

The Findings API is read-only. It returns retained findings and evidence from the selected computer. It cannot launch scans, ingest findings, run commands or reach model credentials.

## Create a credential

Open **Findings API** in the account menu and choose **Create API key**. The token is shown once, so store it in your secret manager. In team mode only workspace owners manage credentials.

Credentials have one scope, `read:findings`. They expire after 90 days by default. Owners can set another future expiry or none. Revocation applies on the next request. Each credential belongs to one workspace.

## Call the API

Send the token in the `Authorization` header:

```sh
curl --header "Authorization: Bearer $ZERO_FINDINGS_API_TOKEN" \
  "http://127.0.0.1:48123/api/v1/findings?limit=50"
```

The computer binds to loopback. Remote integrations need your own authenticated reverse proxy or tunnel. Tokens are not accepted in URLs. They authorize only `GET` and `HEAD` on the routes below, and nothing else in the computer.

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

Rows are ordered by timestamp, then ID, newest first. Keep the same filters while paging, because a cursor is bound to the workspace, database and filters. Paging reads current records, not a frozen snapshot, so findings added between pages show up in a fresh listing.

## Read one finding

`GET /api/v1/findings/:id`

Use an exact finding ID. The response contains `schemaVersion`, `workspaceId`, `scanId`, `target` and `finding`. A missing finding or retained scan returns 404. The API does not search other databases or infer verification from a confirmed finding.

## Export selected evidence

`GET /api/v1/findings/export?id=finding-a&id=finding-b`

Select between 1 and 500 distinct exact finding IDs with repeated `id` parameters. The JSON response contains `schemaVersion: 1`, `workspaceId`, `coverage: "selected-retained-findings"`, and `report`.

The report holds the selected evidence and review fields. It is not proof of full asset coverage. If any selected finding is missing, the export fails instead of dropping it.

## Credential management

These routes need owner control access and, in team mode, a signed-in workspace owner. A `read:findings` token cannot call them.

- `GET /api/findings-access` returns redacted credential metadata.
- `POST /api/findings-access` accepts `{ name, expiresAt?, scopes? }` and returns `{ credential, token }` once. The only permitted scope is `["read:findings"]`; `expiresAt` is a future ISO timestamp or `null`.
- `DELETE /api/findings-access/:id` revokes the credential.

Stored credentials hold hashes and metadata, never the plaintext token. Revoked credentials stay listed for audit.

Next: [Findings](/findings/), [Reports and disclosure](/reports/).
