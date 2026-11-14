---
title: Remote engines and teams
description: Run a 0 engine on a server or VM, connect to it from the browser, CLI or MCP, and share a workspace with teammates.
---

An engine owns missions, automation runs, workspace paths and execution. Selecting another engine changes where work runs. It does not select a model, copy a repository or turn a model provider into a remote execution service.

## Deploy a worker

The fastest way to get a remote engine is `0 worker deploy`. It installs 0 on a Linux host, starts an engine, opens a tunnel and registers it.

```bash
0 worker hosts                         # SSH hosts from ~/.ssh/config
0 worker deploy --ssh user@host        # any SSH host with key auth
0 worker deploy --lima zero-worker     # a Lima VM (default name zero-worker)
```

| Option | Meaning |
| --- | --- |
| `--ssh <user@host>` | SSH target. Uses BatchMode and key auth. |
| `--ssh-config <path>` | OpenSSH config file for the target. |
| `--lima <name>` | Lima instance. Default `zero-worker`. |
| `--target-git <url>` | Repository the worker clones into its workspace. |
| `--engine-port <port>` | Engine port on the worker. Default is stable per host. |
| `--forward-provider-key` | Forward this machine's `OPENAI_API_KEY` to the worker. Use only on hosts you own. |
| `--engines-config <path>` | Registry file to update. |

Manage a deployed worker by its engine ID:

```bash
0 worker repair <id>   # reconnect the tunnel and restart the engine if needed
0 worker stop <id>     # stop the engine and tunnel; keeps remote files and registration
```

The browser app also deploys workers from its engine selector.

## Run an engine by hand

Install 0 on the server. Give the server its own model connection (see [Models and keys](/models/)) and prepare its repositories, scope and any VM, Docker or replay prerequisites there.

Set one secret of 32 to 4096 non-whitespace characters in `ZERO_REMOTE_ENGINE_TOKEN` (any variable name works) on the server and on the machine that connects. It is separate from the browser control token. Start an engine admitted to one repository:

```bash
0 web --host 127.0.0.1 --port 48123 --no-open \
  --engine-token-env ZERO_REMOTE_ENGINE_TOKEN \
  --engine-workspace /srv/repos/app --engine-target /srv/repos/app
```

| Server option | Meaning |
| --- | --- |
| `--engine-workspace <path>` | Authorize a source workspace on the engine. |
| `--engine-scope <path>` | Scope JSON for live-target work. |
| `--engine-target <target>` | Restrict automation requests to this target. |
| `--engine-allow-apply` | Admit requests to apply an exact, approved fix candidate. |
| `--engine-time-cap <ms>` | Limit per automation run. Default `600000`. |
| `--engine-cost-cap <usd>` | Limit per automation run. Default `5`. |

Admission options need `--engine-token-env` or `--team-config`. Clients can ask for lower limits but cannot raise these or replace the server's workspace, scope, provider or model.

Keep the listener on loopback and reach it through an SSH tunnel:

```bash
ssh -N -L 48124:127.0.0.1:48123 user@server
```

HTTPS endpoints work too. Plain HTTP is accepted only for loopback. The endpoint must speak the versioned engine handshake and authenticated control API. A model provider URL or arbitrary HTTP service does not qualify.

## Register the engine

Create `engines.json` in `~/.0/`, or pass another file with `--engines-config`:

```json
{
  "schemaVersion": 1,
  "engines": [
    {
      "id": "staging",
      "name": "Staging engine",
      "url": "http://127.0.0.1:48124",
      "bearerTokenEnv": "ZERO_REMOTE_ENGINE_TOKEN"
    }
  ]
}
```

The file holds the name of the environment variable, never the token. The limit is 32 engines and 64 KiB. Add `expectedEngineId` to pin the engine identity across restarts. Without it, the first identity accepted is pinned for the life of the connection service, and a different identity is rejected.

Older versions used `backends.json`, `--backend` and `--backends-config`. 0 reads `engines.json` first, falls back to an existing `backends.json` only if `engines.json` is missing, and writes only `engines.json`.

Start the browser app with the registry and pick the engine in the selector:

```bash
0 web --engines-config /absolute/path/engines.json
```

Missions, runs, workspaces and approvals belong to the engine you chose. `/srv/repos/app` is resolved on the server, not on your laptop. An unreachable or incompatible engine never falls back to local execution.

### Local Codex model for a remote mission

A browser mission can run its tools on a remote engine while its model requests use your local ChatGPT Codex sign-in. Pick the remote host for execution and the local model source for that mission. Provider tokens stay on your machine. Prompts, tool results and responses pass through a mission-scoped relay, and they can contain remote workspace data.

Only `chatgpt-codex` is supported, with the remote engine's host-local execution profile. The relay must be reconnected after an engine or owner restart. CLI and MCP automations still use the server's own provider.

## Use it from the CLI and MCP

The CLI and the MCP adapter select the same registered engine. They never use your laptop's provider, filesystem or database for remote targets.

```bash
0 automation list --templates --engine staging --engines-config /abs/engines.json --format json
0 automation run --template repository-review --target /srv/repos/app \
  --engine staging --engines-config /abs/engines.json --format json
0 runs list --engine staging --engines-config /abs/engines.json --format json
0 mcp-server --automations --engine staging --engines-config /abs/engines.json
```

Remote automation rejects client-side `--workspace`, `--scope`, `--db-path` and `--model`. A remote MCP adapter exposes automation tools only, not atomic live-target tools.

For a direct call to an engine API, use `0 api`:

```bash
0 api                                   # engine handshake
0 api /api/work --engine staging
0 api <path> --method POST --data @body.json --engine-url http://127.0.0.1:48124 --engine-token-env ZERO_REMOTE_ENGINE_TOKEN
```

`--data` takes JSON or `@file` (at most 1 MB).

### Continue the same work

```bash
0 chats list --engine staging --format json
0 console --chat <session-id> --engine staging --prompt "Summarize the retained evidence" --format ndjson
0 runs list --all --engine staging --format json
0 runs show workflow:<execution-id> --engine staging --format json
0 runs cancel workflow:<execution-id> --engine staging
```

`--chat` attaches to a live mission. It does not restore an archived one. The mission keeps its model, target, scope and permissions, and local overrides are rejected. A pending decision returns exit status 2 and stays pending in the browser.

`runs list --all` and the **Runs** view share one read model over automations and standalone scans. References look like `workflow:<execution-id>` and `scan:<scan-id>`. The read-only API is `GET /api/work` and `GET /api/work/<reference>`.

## Run lifecycle

- The engine owns run state and results. Closing a browser tab or the tunnel disconnects the client. It does not complete or cancel anything. Reconnect and read the snapshot.
- Cancel on the owning engine. Ctrl-C in the foreground CLI sends the request. Losing a proxy or disposing an MCP adapter does not.
- An approval for one engine, mission, request or fix candidate cannot authorize another.
- Keep the engine process running. There is no crash recovery or detached executor. Stopping the engine ends its in-process work. Saved records and files survive.
- A remote engine uses its own local or VM executors. Giving a local engine an arbitrary remote executor is not implemented.

## Team workspaces

Local use needs no account. Turn on team mode when several people should share one engine and its missions.

In the browser app, choose **Team**, enter a workspace name, your display name, account ID and password, and you are signed in as owner. Add editors and viewers from **Team settings** in the account menu. Only owners add accounts.

From a terminal:

```bash
0 team init --config ./team.json --name "Security" --owner alex --display-name "Alex"
0 team add-user --config ./team.json --user morgan --display-name "Morgan" --role editor
0 team list --config ./team.json
0 web --team-config ./team.json
```

Passwords are read from a prompt or stdin, never from arguments. The file stores salted scrypt hashes. Keep it private (`0600`). `init` never overwrites an existing file. Edits to the file apply when the engine restarts, and a restart ends open missions.

Owners and editors can change work. Viewers can read. Messages keep their authors, and avatars show who is viewing or typing.

Limits: members share one engine workspace, not separate tenants. Each team gets its own mission directory, findings database and reports by default. Existing personal missions are not imported. Use `--db-path` to choose the database to share. The engine binds to loopback. Remote access and a reverse proxy are your deployment work.

### OIDC sign-in

Add an `oidc` object and give each member the provider's verified `oidcSub`. Names and email claims never grant membership or roles.

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

Register the exact callback URL with your provider. Omit `clientSecretEnv` for a public client. Sign-in uses the authorization code flow with PKCE and checks issuer, audience, nonce and signature. Session cookies are HTTP-only and last eight hours.

## Related

[Architecture](/architecture/#execution-ownership-and-engine-connections), [Automations](/automations/), [Agents and MCP](/mcp/), [Reports and disclosure](/reports/).
