---
title: Engine Connections
description: Register a remote 0 engine, keep credentials server-side, and select it from browser, CLI, or MCP.
---

An engine owns its sessions, automation runs, workspace paths and execution
environments. It normally uses its own model connections; browser chats can
explicitly use a local Codex connection through a scoped relay as described below.
Selecting another engine changes where work runs.
It does not select a model, copy a repository, or turn a model provider into a
remote execution service.

## Run an engine on the server

Install 0 on the server. Configure its own model provider using [API Keys](/api-keys/)
for host-managed models and CLI/MCP automations, or use the local Codex relay for
supported browser chats. Prepare the server's repositories, scope configuration, and any required SmolVM,
Docker, replay, or research prerequisites there.

Set the same secret in `ZERO_REMOTE_ENGINE_TOKEN` on the server and in the local
shell that will run the connection proxy. This bearer credential is separate from
the random browser control token. Use a secret of 32–4096 non-whitespace
characters. Start a server engine admitted to one repository:

```bash
0 web --host 127.0.0.1 --port 48123 --no-open \
  --engine-token-env ZERO_REMOTE_ENGINE_TOKEN \
  --engine-workspace /srv/repos/app --engine-target /srv/repos/app
```

The engine applies its own admission settings before allocating an automation run:

| Server option | Meaning |
| --- | --- |
| `--engine-workspace <path>` | Authorize an engine-local source workspace. |
| `--engine-scope <path>` | Load the engine-local scope JSON for live-target work. |
| `--engine-target <target>` | Restrict automation requests to this target. |
| `--engine-allow-apply` | Admit requests to apply an exact approved source-fix candidate. |
| `--engine-time-cap <ms>` | Limit each automation run; default `600000` ms. |
| `--engine-cost-cap <usd>` | Limit each automation run; default `$5`. |

Admission options require `--engine-token-env`. Clients can request lower time and
cost limits, but cannot raise these ceilings or replace the server's workspace,
scope, provider, or model. For live web work, configure the server's scope and
target instead of a repository workspace. Apply requests also need an explicit
request grant and approval of the exact live candidate.

The server's loopback listener remains private. From the local machine, open an
SSH tunnel and leave it running:

```bash
ssh -N -L 48124:127.0.0.1:48123 user@server
```

Registered HTTPS endpoints are also supported. HTTP registration is restricted to
loopback endpoints such as this tunnel. The connection must reach an engine that
supports the versioned handshake and authenticated control API; a URL to a model
provider, terminal bridge, or arbitrary HTTP service does not satisfy that contract.

## Register the connection

Create a trusted local `backends.json`:

```json
{
  "schemaVersion": 1,
  "backends": [
    {
      "id": "staging",
      "name": "Staging engine",
      "url": "http://127.0.0.1:48124",
      "bearerTokenEnv": "ZERO_REMOTE_ENGINE_TOKEN"
    }
  ]
}
```

The default registry is `backends.json` in 0's per-user state directory;
`--backends-config` selects a different trusted file. Configuration is limited to
32 remote connections and a regular JSON file of at most 64 KiB.

The file stores an environment variable name, not the bearer value. The local
connection service reads that credential and attaches it only when contacting
this registered engine. Public descriptors omit credential bindings and secrets.
The browser does not accept arbitrary remote URLs or register credentials.

For a connection that must survive proxy restarts, pin the handshake's `engineId`
with the optional `expectedEngineId` field. Without that field, the connection
service pins the first accepted identity for its own lifetime. A different identity
then becomes incompatible instead of receiving requests for the former engine.
The optional `serverInstanceId` identifies an engine process restart; the browser
refreshes its view and snapshots when that epoch changes.

Launch the local browser console with this registry:

```bash
0 web --backends-config /absolute/path/backends.json
```

Use the engine selector to choose the local engine or the registered server.
Chats, runs, workspaces, drafts, and approvals belong to their chosen engine.
A server workspace such as `/srv/repos/app` is resolved on the server. A similarly
named local directory is a different resource.

The handshake reports protocol version, engine identity, platform, and supported
capabilities. An unreachable or incompatible connection cannot launch work through
a local fallback. Missing executors and engine prerequisites fail before dispatch.

## Use a local Codex connection for a remote chat

For a browser chat, the execution host and model source are separate choices.
Choose the registered server for execution and the local machine for its model
source. A local `chatgpt-codex` account can then power the remote chat without
signing that model account into the remote server. Local provider credentials
stay on the local machine; authorized model requests and streamed responses
travel through the scoped relay. Tool arguments/results and prompts can contain
remote workspace data and are part of those model requests.

This first release supports Codex only, with the remote engine's explicitly
selected host-local execution profile. SmolVM-backed relay execution and other
local providers are unsupported. The relay is bound to its granted chat/model
and engine ownership; a restart or expired relay requires reconnection before
continuing. Remote tools still run under the remote host's scope and permissions.
The relay never supplies provider credentials to the remote host.

The CLI/MCP automation adapters below still use the execution engine's configured
provider. Selecting an engine for an automation does not grant a local model relay.

## Use CLI and MCP clients

The CLI and MCP automation adapters select the same registered engine. They do not
resolve remote targets through the laptop's provider, filesystem, or database.

```bash
0 automation list --templates --backend staging \
  --backends-config /absolute/path/backends.json --format json

0 automation run --template repository-review --target /srv/repos/app \
  --backend staging --backends-config /absolute/path/backends.json \
  --format json

0 runs list --backend staging \
  --backends-config /absolute/path/backends.json --format json
```

Configure the MCP client to start a local stdio adapter:

```bash
0 mcp-server --workflows --backend staging \
  --backends-config /absolute/path/backends.json
```

Its automation discovery, launch, status, results, and cancellation calls go to the
selected engine. The external agent's model decides which requests to make; an
assessment inside 0 uses the server's configured provider. Remote automation mode
rejects client-local `--workspace`, `--scope`, `--db-path`, and `--model` overrides.
A remote MCP adapter exposes automation tools; it cannot mix them with atomic
live-target tools. Selecting an engine does not grant additional target tools,
credentials, or filesystem access.

## Connection and run lifecycle

### Continue the same work across interfaces

Chat, CLI, MCP and the browser use the selected engine's sessions and workflow
lifecycle. To send a headless prompt to an existing browser conversation:

```bash
0 chats list --backend staging --format json
0 console --session <session-id> --backend staging \
  --prompt "Summarize the retained evidence" --format ndjson
0 runs list --all --backend staging --format json
0 runs show workflow:<execution-id> --backend staging --format json
```

`--session` attaches to an existing live session, including a saved alias that
resolves to a live chat. It does not restore an archived chat or create
a replacement. Attached chat uses the engine chat's model, target, scope and
permissions; local configuration overrides are rejected. A pending operator
decision is reported with exit status 2 and remains pending in the browser.
JSON returns one result; NDJSON streams engine events followed by the result.

The browser's **Runs** page and `0 runs list --all` share a
read model over retained automation runs and standalone scans. Canonical
references are `workflow:<execution-id>` and `scan:<scan-id>`. Automation records
retain their chat and native scan IDs; child scans appear within their
automation rather than as duplicate rows. Existing scan links remain usable.
`0 runs list` without `--all` retains its automation-only output for scripts.
Listing retained history does not interrupt active work.
Automation MCP clients expose the same records through `list_work` and
`get_work({ workId })`; existing `list_runs` and `get_run` remain available.
Use `0 runs cancel workflow:<execution-id>` to cancel the owning automation.
Standalone scan records retain their native process/session cancellation path.

The read-only browser API is `GET /api/work` and
`GET /api/work/<encoded-canonical-reference>`. These endpoints require the same
transport and workspace authentication as other dashboard reads. Authenticated
workspace viewers can inspect history without receiving mutation permissions.
The list includes retained automation runs and at most the latest 1,000
standalone scan source records; direct lookup can retrieve an older scan.

Chat's findings view follows explicit automation-to-chat scan references
and historical finding occurrences. A newer occurrence in another run does not
remove the finding from its earlier chat. Native scan, workflow and
conversation storage remain separate; this is shared access and correlation,
not a storage migration. Standalone headless chat without `--session` retains its
existing local execution path.

The selected engine owns authoritative run state and retained results. Closing a
frontend connection or the SSH tunnel disconnects that client; it does not confirm
completion or cancellation. Reconnect to the same engine and inspect its snapshot
and available event history. Event cursors are engine-bound and bounded history
may require a fresh snapshot.

Cancellation must be sent to the owning engine and acknowledged there. The
foreground CLI sends an explicit cancellation request on Ctrl-C; disposing an MCP
adapter or losing a proxy connection detaches without sending that request. An approval
for one engine, chat, request, or exact source-fix candidate cannot authorize a
different engine's operation. Patch application still needs the host and request
grants plus approval of the live candidate; serialized automation JSON carries no
execution proof or future approval.

Keep the engine process running while its work runs. This listener does not add
crash recovery, automatic replay, or a generic detached executor. Stopping the
owning engine ends its in-process execution. Persisted records and filesystem
artifacts can outlive the connection; process-owned candidates and runtime state
cannot be recreated by reading their JSON.

A remote engine can use its own admitted local or SmolVM executors. A separate
protocol that gives a local engine an arbitrary remote executor is not implemented.
See [Architecture](/architecture/#execution-ownership-and-engine-connections),
[Automation CLI](/automations/), and [Integrations](/integrations/) for related contracts.

## Team workspaces

Local use needs no account. Enable team sign-in only when you want workspace
members to share the same engine and retained conversations.

### Create a workspace

Choose **Team** in the web app and create a workspace with its name, your display
name, account ID and password. You are signed in as its owner immediately on the
same server. Personal conversations and findings stay separate. Subsequent
launches in the same project reopen the team workspace automatically.

Open **Team settings** from the account menu to add teammates as editors or
viewers. Only owners can add accounts. New teammates can sign in immediately;
existing chats remain active.

For provisioning from a terminal instead:

```sh
0 team init --config ./team.json --name "Security" --owner alex --display-name "Alex"
0 team add-user --config ./team.json --user morgan --display-name "Morgan" --role editor
0 team list --config ./team.json
0 web --team-config ./team.json
```

The first two commands request a password without displaying it. For automation,
provide the password through standard input from your secret manager. Passwords
are never command arguments; the configuration contains salted scrypt hashes.
Keep the file private (`0600`). Initialization never overwrites an existing file.
Changes made directly to the configuration take effect when the engine restarts;
restarting also ends existing chats. Creating a workspace through the web app
activates it immediately.

Owners and editors can change workspace work. Viewers can read it. Members work independently and can write directly into shared conversations.
Messages keep their authors. Requests in an active conversation queue safely.
Avatars beside chats, reports and automations show who is viewing or typing. [Assessment reports](/scans/#assessment-reports)
collect retained runs and findings for review and export.

Team mode does not isolate members into separate data tenants: they share the
configured engine workspace. Each team gets its own retained chat directory,
findings database and reports by default. Existing personal chats stay personal;
no historical chats are imported automatically. An explicit `--db-path` selects
the database the operator intends to share. The engine still binds to loopback. Remote access,
reverse-proxy configuration and hosted enterprise identity are separate deployment
work; this option does not publish the server.

### Optional provider sign-in

Add an `oidc` object to the configuration and assign each member their provider's
verified `oidcSub`. Provider display names and email claims do not grant membership
or change roles.

```json
{
  "workspace": { "id": "your-workspace-id", "name": "Security" },
  "users": [
    { "id": "alex", "name": "Alex", "role": "owner", "oidcSub": "provider-subject-id" }
  ],
  "oidc": {
    "issuer": "https://identity.example.com",
    "clientId": "your-client-id",
    "clientSecretEnv": "ZERO_TEAM_OIDC_SECRET",
    "redirectUri": "http://127.0.0.1:48123/api/team/auth/callback"
  }
}
```

Register the exact callback URL with your provider and set the client secret in
that environment variable when your provider requires one. Omit `clientSecretEnv`
for a public client. Callback origin and port must match the running engine.
Sign-in uses authorization code flow with PKCE and verifies the issuer, audience,
nonce and signature before looking up workspace membership. Session cookies are
HTTP-only and expire after eight hours; signing out revokes the session.

### Testing

After building the CLI and dashboard, run `pnpm test:team-workspace-api`. It starts a disposable server and exercises owner, editor, and viewer sessions concurrently, including presence, shared edits, findings API access, and restart persistence. It does not start model turns or change an existing workspace.
