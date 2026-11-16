---
title: MCP servers
description: Drive 0 from Claude Code, Codex or Cursor, and give 0 tools from other MCP servers.
---

MCP works in two directions. Run `0 lab mcp-server` so a coding agent can start 0's automations or call its target tools. Or connect other MCP servers to 0 so its agent can use their tools.

## Let a coding agent use 0

### Use the CLI

An agent with shell access can run 0 directly. No MCP adapter is needed. Install 0 where the agent runs, connect a model in [Models and keys](/models/), and give it absolute paths:

```bash
0 scan /absolute/path/to/repo --format json > review.json
0 scan https://target.example.com --scope /absolute/path/to/scope.json --format json > scan.json
```

The **Set up your coding agent** button in the browser app copies a setup prompt. The agent reads `0 --help`, `0 config doctor` and `0 config doctor workbench status --json`, helps you connect a model and sets up MCP only if needed. It never starts a scan or gets access to a new target during setup. Keep sign-in and credentials with you, not in agent chat. `0 --no-open --ready-json` starts a browser app and prints its URL.

Notes for agents:

- 0 uses its own model connection. A coding-agent subscription is not a credential for every 0 runtime.
- Check the exit status and the saved report, not the last stdout line.
- A finding can be a lead. Use [Verify and fix](/verify-and-fix/) before calling it exploitable, and keep fix application a separate, reviewed step.

### Use the MCP server

`0 lab mcp-server` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio. Add it to a client that launches local stdio servers. This example uses the common `mcpServers` shape:

```json
{
  "mcpServers": {
    "0": {
      "command": "0",
      "args": ["mcp-server", "--automations", "--workspace", "/absolute/path/to/repo"]
    }
  }
}
```

Use an absolute `command` path if a GUI client cannot find `0` on its `PATH`. stdout carries protocol frames only, and logs go to stderr. The client owns the process, and active owned runs are cancelled on disconnect.

There are two tool sets:

| Flag | Tools |
| --- | --- |
| `--automations` | Templates, saved automations, runs, sessions and scan resume. |
| none (default) | Live target tools such as `http_request` and `crawl`. |

`--tools a,b,c` selects exactly those tools, from either set, and overrides the default. The external agent reasons with its own model. Assessments that run inside 0 use 0's [model connection](/models/).

Host-local execution is required for local-target stdio. The SmolVM CLI bridge cannot forward the stdio MCP transport, so startup fails before it boots a VM or reads credentials. For isolated execution use `0 agents run --automation`. Switching to host execution with `0 config doctor workbench disable` changes the sandbox boundary. Do it yourself, never from a connecting agent.

## Automation tools

```bash
# Source workflows in a local repository
0 lab mcp-server --automations --workspace /absolute/path/to/repo

# Live targets (needs the scope extension and a scope file)
0 skills extensions enable scope
0 lab mcp-server --automations --scope /absolute/path/to/scope.json \
  --target https://target.example.com
```

`--workspace` authorizes local source targets inside that root, with canonical path checks. Live workflow targets need `--scope` and the enabled `scope` plugin, and `--target` can pin the only accepted target. Live flags do not authorize local source access, and `--workspace` does not authorize live targets.

| Tool | Purpose |
| --- | --- |
| `list_templates`, `get_template` | Read versioned templates and the target types they accept. |
| `list_workflows`, `get_workflow` | Read saved definitions and revisions. |
| `save_workflow` | Validate and save a definition. Accepts `expectedRevision`. |
| `start_run` | Start one template or saved workflow and return the run ID. |
| `list_runs`, `get_run`, `get_run_results` | Read retained runs, status and findings. |
| `cancel_run` | Request cancellation. |
| `start_assessment` | Start an assessment from a complete plan: `goal`, `depth`, `runCount`, `executionMode`, `timeCapMs`, `costCapUsd`. |
| `resume_scan` | Resume persisted scan work, when the computer supports it. |
| `get_capabilities` | List the operations the computer supports. |

The server also exposes session tools: `list_sessions`, `create_session`, `attach_session`, `get_session`, `get_session_events`, `send_message`, `continue_session`, `cancel_session`, `resolve_decision`, `list_saved_sessions` and `resume_session`. Resuming a saved session creates a new one under current grants. Use `--tools` to expose only what the client needs.

Start a run:

```json
{
  "templateId": "repository-review",
  "revision": 1,
  "target": "/absolute/path/to/repo",
  "idempotencyKey": "review-request-1"
}
```

- Pass exactly one of `templateId` or `workflowId`. Saved workflows need `revision`. `timeCapMs` and `costCapUsd` narrow the limits.
- The same idempotency key with the same request returns the same run. Reusing the key with a changed request is rejected.
- `get_run_results` takes `runId`, a numeric `cursor` and a `limit` from 1 to 100.
- `start_run.inputs` is a JSON object up to 32 KiB. Finding steps take `findingId`, `findingPath` or a structured `finding`. Fix steps need `testCommand`. Verification takes a `runner` such as `local`, `smolvm`, `docker` or `qemu`. Inputs never grant filesystem access, credentials or apply permission.
- Applying a patch needs the host flag `--allow-apply` and `allowApply: true` in the request, plus an authorized source workspace. Proposing a fix and applying it are separate.
- A step whose executor is missing fails before launch.

In browser chat, `start_run` returns a queued `requestId`. It runs only after the turn ends and you approve the launch and target. Read `get_run` with that request ID to get the `runId`. Changing the chat's configuration cancels the request.

## Attach to a running computer

By default the MCP server embeds a computer that stops when the client disconnects. To use a running one, such as the browser app's computer:

```bash
0 lab mcp-server --automations \
  --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN \
  --chat SESSION_ID
```

`ENGINE_TOKEN` holds the bearer token, so the value never appears in arguments or reports. Direct connections use HTTPS, or HTTP on loopback. For a registered remote computer:

```bash
0 lab mcp-server --automations --engine production --engines-config /absolute/path/to/engines.json
```

The computer supplies its own workspace, scope, model and execution profile, so do not pass `--workspace`, `--scope` or `--db-path`. It must advertise `workflow-engine`. Disconnecting detaches the client and the computer's runs continue until they finish or you cancel them. See [Computers](/engines/).

A web computer that owns the same control database and workspace is found and attached automatically. If it cannot be authenticated, attachment fails and no replacement starts. `start_run.sessionId` binds a run to an existing session, overriding `--chat`. A missing session fails the call.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--automations` | off | Expose automation, session and resume tools instead of live tools. |
| `--workspace <path>` | none | Absolute authorized root for source workflows. |
| `--allow-apply` | off | Permit explicit apply requests in that workspace. |
| `--scope <path>` | none | [Scope](/scope/) file. |
| `--target <url>` | none | Target URL. Required when live tools are selected. |
| `--scan-id <id>` | none | Scan ID for live-tool findings. Required when live tools are selected. |
| `--tools <names>` | by set | Exact comma-separated tool list. |
| `--engine <id>`, `--engines-config <path>` | none | Attach to a registered computer. |
| `--engine-url <url>`, `--engine-token-env <name>` | none | Attach directly to a running computer. |
| `--chat <id>` | none | Default existing session for run starts. |
| `--db-path <path>` | none | SQLite database. |
| `--timeout <ms>` | `30000` | Per-tool timeout (minimum 1000). |
| `--rate-limit <spec>` | 5 rps per host | Request rate limit. A profile can only lower it. |
| `--allow-scanners` | off | Allow generic scanner tools in scoped engagements. |
| `--engagement-profile <name>` | `standard` | `standard`, or `conservative` (1 rps per host, full jitter, no WAF evasion). |
| `--no-waf-evasion` | evasion on | Turn off the adaptive WAF-evasion ladder. |

## Live target tools

Select these with `--tools`. They need `--target` and `--scan-id`.

```bash
0 lab mcp-server \
  --target https://target.example.com --scan-id my-scan-001 \
  --scope /absolute/path/to/scope.json \
  --tools http_request,crawl,query_findings
```

| Tool | Purpose |
| --- | --- |
| `http_request` | Send an HTTP request to the target. |
| `crawl` | Crawl the app for endpoints. |
| `submit_form` | Submit a form. |
| `send_prompt` | Send a prompt to the LLM target under test, not to a provider model. |
| `save_finding`, `query_findings`, `update_finding` | Persist, read and update findings. |
| `update_target` | Update the target definition mid-session. |
| `done` | Signal completion. |
| `payload_lookup` | Look up a known payload. |
| `wp_fingerprint` | Fingerprint WordPress. |
| `mongo_objectid` | Generate or extract MongoDB ObjectIds. |

Set target authentication with `ZERO_MCP_AUTH_JSON`, through your client's secret mechanism. It takes one of:

```json
{"type":"bearer","token":"..."}
{"type":"cookie","value":"session=abc123"}
{"type":"basic","username":"admin","password":"..."}
{"type":"header","name":"X-API-Key","value":"..."}
```

For authorized engagements, `ZERO_MCP_ATTRIBUTION_HEADERS_JSON` (a JSON array of `"Header-Name: value"` strings) adds headers, and `ZERO_MCP_ATTRIBUTION_UA_TOKEN` appends a token to the User-Agent.

With `--engagement-profile conservative`, an explicit `--rate-limit` is clamped to 1 rps and never raised. The server tries to record an `engagement_posture_applied` event and prints the effective posture to stderr. `--scan-id` ties tool state to an ID. It does not create a scan pipeline or run a verifier.

There is no interactive approval in this server. Limit the tool list, pass `--scope`, and only test systems you are authorized to assess.

## Connect other MCP servers to 0

### From the browser app

Open **Plugins**, press **Add** and choose **MCP server** (stdio, HTTP or SSE), or **From marketplace** or **From GitHub repository** for plugins. Nothing runs until you review the exact command and settings and approve them. New servers are saved disabled. Press **Test** to see its tools. Read [Plugin security](/plugin-trust/) first.

### From the command line

```sh
0 skills add --mcp docs -- npx some-mcp-server        # shows the review; add --yes to approve it
0 skills list custom-docs --mcp-test
0 skills list --mcp
0 skills list custom-docs --mcp-remove --yes
0 skills list --connectors
0 skills add --connect linear --secret-env token=LINEAR_API_KEY --yes
0 skills add --disconnect linear --yes
```

Secrets come from environment variables (`--secret-env`, `--env-from`, `--header-from`), never from the command line. Every command takes `--json`.

### From the environment

The browser app and headless chat commands also read the JSON array in `ZERO_MCP`. It is an array, not a `{"mcpServers": ...}` object and not a file path:

```bash
env 'ZERO_MCP=[{"id":"workspace","command":"node","args":["/absolute/path/to/mcp-server.js"],"cwd":"/absolute/path/to/workspace"}]' \
  0
```

- Local entries take `id`, `command` and optional `args`, `env` (string values) and `cwd`. Install the server's dependencies yourself.
- Remote entries take `id`, `url` and optional `headers` (string values). Use Streamable HTTP. HTTPS is required except on loopback, and redirects are rejected so auth headers never follow to another host.
- Both kinds can share one array.
- Tools appear as `mcp__<server-id>__<tool-name>`. Results are untrusted, and tools count as network-capable for authorization.
- Malformed entries and failed connections are skipped, and startup continues. An empty tool list can mean a bad array, path or handshake, so check those first.
- Starting a configured stdio server runs its code as you. Give it only the credentials and files it needs.
- External MCP tools attach to local-execution sessions and are not forwarded into the SmolVM workbench.

### Elastic

Connect Elastic Agent Builder through its Kibana MCP endpoint with an API key that has Agent Builder privileges. Keep the key out of arguments:

```bash
export ZERO_MCP="$(node --input-type=module -e '
  const { KIBANA_URL, ELASTIC_API_KEY } = process.env;
  if (!KIBANA_URL || !ELASTIC_API_KEY) throw new Error("Set KIBANA_URL and ELASTIC_API_KEY");
  console.log(JSON.stringify([{
    id: "elastic",
    url: new URL("api/agent_builder/mcp", KIBANA_URL.replace(/\/$/, "") + "/").href,
    headers: { Authorization: "ApiKey " + ELASTIC_API_KEY }
  }]));
')"
0
```

A custom Kibana Space uses `/s/<space>/api/agent_builder/mcp`. 0 discovers the tools from your deployment. See [Elastic MCP authentication](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/mcp-server-api-keys). You can also connect Elastic from **Plugins**.

## MCP servers in extensions

An extension can bundle MCP servers, so installing one is a single, reviewed step. Declare them in `extension.json` under `"0": { "mcp": { ... } }`, or ship a Claude-style `.mcp.json`. The shape is the same as `.mcp.json`: a `command` and `args` for a local server, or a `url` (with `"type": "http"` or `"sse"`) for a remote one, plus the names of environment variables the server needs under `env` and an optional one-line `description`. Values are never stored in the extension. The install prompt lists every server, command, argument, URL and variable name, and changing any of them asks again.

- **Lazy.** Nothing starts when a thread opens. The tool list holds one entry per server (its name and one line), which you can see with `list_tools`. When the model needs a server it calls `load_tool` on that entry; the server starts, its tools are checked, and they become callable on the next turn. Tool schemas never sit in every prompt, so the default tool list stays small and identical from turn to turn.
- **Commands and network.** Starting a local server is a `process` command and connecting to a URL is a `network` command, so both go through `beforeCommand` with your scope and "Ask before running commands" setting. A deny keeps the server from starting. Local servers run in the extension's folder with only the variable names they declared (plus a small base set); model provider keys are not passed unless declared and approved.
- **Pinned tools.** The first time a server connects, 0 asks you to approve its tools. It records a sha256 of each tool's name, description, input schema and annotations. On every later connection the hashes are compared. If any tool is changed, new or removed, the whole server is blocked, nothing from it is advertised or callable, and the thread shows one line such as `changed: echo; blocked until you approve them again`. Approve again in the thread when asked, or review it on the Extensions page, which shows Changed, New and Removed. With nobody to ask (no approval channel), it stays blocked.
- **Untrusted results.** A tool's output is labelled as untrusted data, cannot close its own label, and is cut at 32 KB. A tool description is the server's own text and is shown to the model as such; it is never part of the system prompt and cannot change scope, approvals or rules.

`0 skills extensions info <name>` lists the extension's servers and, for each tool, the approved hash and the hash last seen.

Servers you added yourself on the MCP page keep working. The importer turns them into local extensions that need approval; once such an extension is approved and enabled, it is the extension that starts the server.

## Service connections

In **Plugins** you can connect GitHub, Elastic, Semgrep, Snyk, Linear, Jira, Cloudflare, Slack and Microsoft Teams. Each connection is tested before it is saved. Connected ones have an on/off switch, and changes apply to new threads. Leaving a saved secret field blank keeps it.

| Service | Tools |
| --- | --- |
| GitHub | Repositories, code scanning and Dependabot alerts, issues, pull requests. |
| Elastic | Whatever the deployment's Agent Builder endpoint offers. |
| Semgrep | Projects and existing findings in a deployment. |
| Snyk | Projects and existing issues in an organization. |
| Linear | Teams, issues, creating remediation issues. |
| Jira | Projects, JQL search, creating remediation issues. |
| Cloudflare | Zones, DNS records, rulesets. |
| Slack | Channels, recent messages, posting summaries. |
| Microsoft Teams | Joined teams, channels, posting channel messages. |

Setup uses vendor API tokens. Jira Cloud also needs an account email and site URL, Elastic its Kibana URL, Semgrep a deployment ID and Snyk an organization ID. Teams needs a delegated Microsoft Graph token with the right permissions, and you reconnect when it expires. There is no browser OAuth or token refresh. Semgrep and Snyk read their own findings and do not start a local scan.

Credentials are stored for the operator in `~/.0/service-plugins.json` (mode `0600`, directory `0700`) and are never part of portable automation JSON. The API returns only non-secret settings and tool metadata. Connecting a service does not widen the token's vendor permissions.

Local threads connect enabled accounts directly. SmolVM threads get only the enabled credentials you configured, over private stdin, and connect from inside the guest. This needs the workbench network grant, since **Plugins** does not turn networking on. Existing threads keep their original tools.

## Next steps

- [Automations](/automations/): the runs these tools start.
- [Plugin security](/plugin-trust/): what an MCP server can do on your computer.
- [Scope](/scope/): authorize targets before a live run.
