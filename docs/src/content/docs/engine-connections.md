---
title: Engine Connections
description: Register a remote 0 engine, keep credentials server-side, and select it from browser, CLI, or MCP.
---

An engine owns its sessions, workflow runs, workspace paths, model connections,
and execution environments. Selecting another engine changes where work runs.
It does not select a model, copy a repository, or turn a model provider into a
remote execution service.

## Run an engine on the server

Install 0 and configure its model provider on the server using [API Keys](/api-keys/).
Prepare the server's repositories, scope configuration, and any required SmolVM,
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

The engine applies its own admission settings before allocating a workflow run:

| Server option | Meaning |
| --- | --- |
| `--engine-workspace <path>` | Authorize an engine-local source workspace. |
| `--engine-scope <path>` | Load the engine-local scope JSON for live-target work. |
| `--engine-target <target>` | Restrict workflow requests to this target. |
| `--engine-allow-apply` | Admit requests to apply an exact approved source-fix candidate. |
| `--engine-time-cap <ms>` | Limit each workflow run; default `600000` ms. |
| `--engine-cost-cap <usd>` | Limit each workflow run; default `$5`. |

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
Sessions, runs, workspaces, drafts, and approvals belong to their chosen engine.
A server workspace such as `/srv/repos/app` is resolved on the server. A similarly
named local directory is a different resource.

The handshake reports protocol version, engine identity, platform, and supported
capabilities. An unreachable or incompatible connection cannot launch work through
a local fallback. Missing executors and engine prerequisites fail before dispatch.

## Use CLI and MCP clients

The CLI and MCP workflow adapters select the same registered engine. They do not
resolve remote targets through the laptop's provider, filesystem, or database.

```bash
0 workflow list --templates --backend staging \
  --backends-config /absolute/path/backends.json --format json

0 workflow run --template repository-review --target /srv/repos/app \
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

Its workflow discovery, launch, status, results, and cancellation calls go to the
selected engine. The external agent's model decides which requests to make; an
assessment inside 0 uses the server's configured provider. Remote workflow mode
rejects client-local `--workspace`, `--scope`, `--db-path`, and `--model` overrides.
A remote MCP adapter exposes workflow tools; it cannot mix them with atomic
live-target tools. Selecting a backend does not grant additional target tools,
credentials, or filesystem access.

## Connection and run lifecycle

The selected engine owns authoritative run state and retained results. Closing a
frontend connection or the SSH tunnel disconnects that client; it does not confirm
completion or cancellation. Reconnect to the same engine and inspect its snapshot
and available event history. Event cursors are engine-bound and bounded history
may require a fresh snapshot.

Cancellation must be sent to the owning engine and acknowledged there. The
foreground CLI sends an explicit cancellation request on Ctrl-C; disposing an MCP
adapter or losing a proxy connection detaches without sending that request. An approval
for one engine, session, request, or exact source-fix candidate cannot authorize a
different engine's operation. Patch application still needs the host and request
grants plus approval of the live candidate; serialized workflow JSON carries no
execution proof or future approval.

Keep the engine process running while its work runs. This listener does not add
crash recovery, automatic replay, or a generic detached executor. Stopping the
owning engine ends its in-process execution. Persisted records and filesystem
artifacts can outlive the connection; process-owned candidates and runtime state
cannot be recreated by reading their JSON.

A remote engine can use its own admitted local or SmolVM executors. A separate
protocol that gives a local engine an arbitrary remote executor is not implemented.
See [Architecture](/architecture/#execution-ownership-and-engine-connections),
[Workflow CLI](/workflow/), and [Integrations](/integrations/) for related contracts.
