---
title: Computers
description: Run 0 on a server or VM, connect to it from the browser, CLI or MCP, and keep work running on the machine that owns it.
---

A computer owns threads, automation runs, workspace paths and execution. Choosing another computer changes where work runs. It does not pick a model or copy a repository.

## Deploy a worker

`0 computers add` installs 0 on a Linux host, starts a computer, opens a tunnel and registers it.

```bash
0 computers list                          # registered computers
0 computers hosts                         # SSH hosts from ~/.ssh/config
0 computers add --ssh user@host        # any SSH host with key auth
0 computers add --lima zero-worker     # a Lima VM (default name zero-worker)
```

| Option | Meaning |
| --- | --- |
| `--ssh <user@host>` | SSH target. Uses BatchMode and key auth. |
| `--ssh-config <path>` | OpenSSH config file for the target. |
| `--lima <name>` | Lima instance. Default `zero-worker`. |
| `--target-git <url>` | Repository the worker clones into its workspace. |
| `--engine-port <port>` | Computer port on the worker. Default is stable per host. |
| `--trust-new-host` | Trust and remember the computer's SSH host key the first time you connect. Without it, an unknown computer is refused and the message tells you to check it with `ssh <host>`. |
| `--forward-provider-key` | Forward this machine's `OPENAI_API_KEY` to the worker. Use only on hosts you own. |
| `--engines-config <path>` | Registry file to update. |

Manage a deployed worker by its computer ID:

```bash
0 computers repair <id>   # reconnect the tunnel and restart the engine if needed
0 computers stop <id>     # stop the engine and tunnel; keeps remote files and registration
0 computers remove <id>   # forget the computer on this machine; remote files stay
```

0 copies its own bundle to the computer, so it must be able to find `dist/0.js` and `vendor/`. In a source checkout run `pnpm run build:bundle` once. An installed binary has no such files: set `ZERO_WORKER_ASSETS` to a folder that has them, or use the container image. The target must be Linux with `sudo` (to install Node 24 and a C compiler the first time).

The browser app also deploys workers from its computer selector.

## Run a computer by hand

Install 0 on the server. Give it its own model connection (see [Models](/models/)) and prepare its repositories, scope and any VM or Docker prerequisites there.

Set a secret of 32 to 4096 non-whitespace characters in an environment variable on the server and on the machine that connects. This page uses `ZERO_REMOTE_ENGINE_TOKEN`, but any name works. It is separate from the browser control token. Start a computer admitted to one repository:

```bash
0 --host 127.0.0.1 --port 48123 --no-open \
  --engine-token-env ZERO_REMOTE_ENGINE_TOKEN \
  --engine-workspace /srv/repos/app --engine-target /srv/repos/app
```

| Server option | Meaning |
| --- | --- |
| `--engine-workspace <path>` | Authorize a source workspace on the computer. |
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

HTTPS endpoints work too. Plain HTTP is accepted only for loopback. The endpoint must speak the versioned computer handshake and authenticated control API. A model provider URL or other HTTP service does not qualify.

## Register the computer

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

The file holds the name of the environment variable, never the token. The limit is 32 computers and 64 KiB. Add `expectedEngineId` to pin the computer identity across restarts. Without it, the first identity accepted is pinned for the life of the connection service, and a different identity is rejected.

Older versions used `backends.json`, `--backend` and `--backends-config`. 0 reads `engines.json` first, falls back to an existing `backends.json` only if `engines.json` is missing, and writes only `engines.json`.

Start the browser app with the registry and pick the computer in the selector:

```bash
0 --engines-config /absolute/path/engines.json
```

Threads, runs, workspaces and approvals belong to the computer you chose. `/srv/repos/app` is resolved on the server, not on your laptop. An unreachable or incompatible computer never falls back to local execution.

### Local Codex model for a remote thread

A browser thread can run its tools on a remote computer while its model requests use your local ChatGPT Codex sign-in. Pick the remote host for execution and the local model source for that thread. Provider tokens stay on your machine. Prompts, tool results and responses pass through a thread-scoped relay, and they can contain remote workspace data.

If this machine is not signed in to ChatGPT, creating the thread fails with a message that says so. A computer added with `--forward-provider-key` can run threads on its own `OPENAI_API_KEY` through the commands in [Continue the same work](#continue-the-same-work).

Only `chatgpt-codex` is supported, with the remote computer's host-local execution profile. The relay must be reconnected after a computer or owner restart. CLI and MCP automations still use the server's own provider.

## Use it from the CLI and MCP

The CLI and the MCP adapter select the same registered computer. They never use your laptop's provider, filesystem or database for remote targets.

```bash
0 agents list --automation --templates --engine staging --engines-config /abs/engines.json --format json
0 agents run --automation --template repository-review --target /srv/repos/app \
  --engine staging --engines-config /abs/engines.json --format json
0 lab runs list --engine staging --engines-config /abs/engines.json --format json
0 lab mcp-server --automations --engine staging --engines-config /abs/engines.json
```

Remote automation rejects client-side `--workspace`, `--scope`, `--db-path` and `--model`. A remote MCP adapter exposes automation tools only, not atomic live-target tools.

For a direct call to a computer API, use `0 api`:

```bash
0 api                                   # engine handshake
0 api /api/work --engine staging
0 api <path> --method POST --data @body.json --engine-url http://127.0.0.1:48124 --engine-token-env ZERO_REMOTE_ENGINE_TOKEN
```

`--data` takes JSON or `@file` (at most 1 MB).

### Continue the same work

```bash
0 threads list --engine staging --format json
0 lab console --chat <session-id> --engine staging --prompt "Summarize the retained evidence" --format ndjson
0 lab runs list --all --engine staging --format json
0 lab runs show workflow:<execution-id> --engine staging --format json
0 lab runs cancel workflow:<execution-id> --engine staging
```

`--chat` attaches to a live thread. It does not restore an archived one. The thread keeps its model, target, scope and permissions, and local overrides are rejected. A pending decision returns exit status 2 and stays pending in the browser.

`runs list --all` and the **Runs** view share one read model over automations and standalone scans. References look like `workflow:<execution-id>` and `scan:<scan-id>`. The read-only API is `GET /api/work` and `GET /api/work/<reference>`.

## Run lifecycle

- The computer owns run state and results. Closing a browser tab or the tunnel disconnects the client. It does not complete or cancel anything. Reconnect and read the snapshot.
- Cancel on the owning computer. Ctrl-C in the foreground CLI sends the request. Losing a proxy or disposing an MCP adapter does not.
- An approval for one computer, thread, request or fix candidate cannot authorize another.
- Keep the computer process running. There is no crash recovery or detached executor. Stopping the computer ends its in-process work. Saved records and files survive.
- A remote computer uses its own local or VM executors. Giving a local computer an arbitrary remote executor is not implemented.

## Next

[Agents](/agents/#automations), [Threads](/threads/), [Server mode and Docker](/server-mode/).
