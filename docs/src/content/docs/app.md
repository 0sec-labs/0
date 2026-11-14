---
title: Browser app
description: Run missions, review findings and manage 0 from the local browser app, or run the same engine headless.
---

The browser app is where you talk to the agent, watch it work and review what it found.

```bash
0
```

`0` (or `0 web`) starts a local engine and opens the app. No account is needed. It binds to `127.0.0.1:48123` by default.

| Flag | Default | Effect |
| --- | --- | --- |
| `--port <port>` | `48123` | Port to bind. `0` picks a free loopback port. |
| `--host <host>` | `127.0.0.1` | Loopback address to bind (`127.0.0.0/8` or `::1`). |
| `--no-open` | | Start without opening a browser. |
| `--db-path <path>` | local store | SQLite database for findings and runs. |
| `--ready-json` | | Print the bound URL as JSON, for scripts. |

Run `0 web --help` for the full list.

## Find your way around

The sidebar holds:

- **New mission** and your mission history.
- **Findings**, with a count of open findings.
- **Automations** and **Skills**.
- **More…**: **Plugins**, **Memory** and **Engines**.
- Your **Sentinels**, when the engine supports them.

**Settings** has three groups:

- **Preferences**: **Updates**, **Appearance**, **Missions**, **Transcript**, **Cost & context**, **Agents & execution**, **Data & privacy**, **Shortcuts**, **Usage** and more.
- **Agent**: **Connections** (provider keys and sign-ins), **Models** and **Tools**.
- **System**: **Workspace**, **Diagnostics** and **Fixes**.

| Shortcut | Action |
| --- | --- |
| ⌘K | Search anything |
| ⇧⌘O | New mission |
| ⌘, | Open Settings |
| ⇧⌘S | Show or hide the sidebar |

On Linux and Windows, use Ctrl instead of ⌘.

## Run a mission

1. Press **New mission**.
2. Pick a workspace folder if the job involves code.
3. Choose a model with the model picker under the composer. Connect a provider first if the list is empty; see [Models and keys](/models/).
4. Describe the job in plain words, for example "Review this repo for auth bypasses and verify anything you find".
5. Watch tool activity and agents in the transcript. Findings land in **Findings**.

The composer also has:

- **Add to message**: attach images or text files, or reference a file path.
- **Thinking effort**, for models that support it.
- **Mode** (see below).
- Slash commands. Type `/` to list them. For example `/model`, `/connect`, `/findings`, `/skills`, `/doctor` and `/explain`.

### Modes

| Mode | Behavior |
| --- | --- |
| **YOLO** | Acts without per-action prompts. The default for new missions. |
| **Standard** | Asks before each action. |

Switching to YOLO also resumes actions waiting for approval. Scope grants, folder grants and questions the agent asks you stay separate decisions. Existing missions keep their mode until you change it. Credential, private-network and sandbox protections apply in both modes.

### Sending while the agent works

A message you send during a response is queued. It goes out when the current response finishes, so the agent's work is kept. Press **Send now** on a queued message to interrupt and send it at once. Press **Stop response** to stop.

Background agents that a mission starts keep running after its response ends. Stop them from the agents panel. They belong to the live mission and do not survive an engine restart.

If a model connection drops, the mission reconnects and continues from its last completed tool result. Completed tool actions are not replayed.

### Web search

The agent has a `web_search` tool and decides when to use it. Queries go to [Parallel's anonymous hosted search](https://parallel.ai/mcp), with DuckDuckGo as a fallback. No search key is needed. Results are links and snippets, not proof a page was read in full.

Set `ZERO_FEATURE_WEB_SEARCH=0` on the engine to turn search off by default. This controls the search tool only, not all network access.

### Public source

In YOLO, the agent can clone a public HTTPS repository to review it. Cloning does not add the hosting service to your scope. Scope exclusions and private-network restrictions still apply. See [Scope and authorization](/scope/#local-workflows-and-strict-scope-mode).

### Access programs

The **Daybreak** control next to the model settings requests an OpenAI cyber access program (**Daybreak Blue** or **Daybreak Red**) for eligible OpenAI and ChatGPT Codex connections. **Automatic** clears the request. See [Models and keys](/models/#cyber-access-programs).

## Memory

**Memory** holds lessons the agent saved while reading source code. Each lesson records its project folder and supporting files with content fingerprints. Before a lesson is reused, 0 checks those files. If a file changed or is missing, the lesson is skipped.

- Open **Supporting files** on a lesson to see its evidence.
- Press **Stop using** to keep a lesson out of future context. The record stays for inspection.

Lessons are hints for the agent to check again, not verified findings. A finished mission does not become a lesson on its own. Lessons live in the engine's private state, outside your repository, and are sent to your model as context when recalled. Set `ZERO_DISABLE_HUNT_MEMORY=1` on the engine to turn source lessons off.

## Visualizations

The agent can put a visual in a mission with its `visualize` tool: an attack path, an incident timeline or a table of findings. Visuals are saved with the mission and replay when you reopen it.

| `kind` | Use for |
| --- | --- |
| `graph`, `attack-graph` | Nodes and edges (hosts, services, identities, vulnerabilities, steps) with optional severity. Layouts: layered, force, radial. |
| `chart` | `bar`, `line`, `area`, `pie` or `stacked`. |
| `timeline` | Dated events. |
| `table` | Columns and rows. |
| `mermaid` | Sequence or flow diagrams. |

Every visual has a title and a summary. The summary is the alt text and states the conclusion.

Oversized visuals fail validation and the model retries. Nothing is truncated silently.

| Limit | Value |
| --- | --- |
| Spec size | 64 KB |
| Graph | 200 nodes, 400 edges, 30 groups |
| Chart | 12 series, 500 points per series, 2,000 total |
| Timeline | 200 events |
| Table | 20 columns, 500 rows |
| Mermaid source | 10,000 bytes |
| Per mission | 200 visuals |

Titles are at most 120 characters, summaries 600, captions 300 and labels 80.

Visuals are plain data, never HTML:

- Markup, URLs, `javascript:` and `data:` schemes, control characters and bidi overrides are rejected.
- A node can point to a finding, a file or an agent by id. It is never a link.
- The app renders visuals with its own components and sanitizes Mermaid (no click handlers, no script labels).

Target content is attacker-controlled, so the agent is told to shorten labels and not copy target text verbatim.

## Saved missions

A saved mission opens at `/chats/saved/<id>` as a read-only transcript. Use mission history or ⌘K search to find older work. Search matches message text and metadata, ranks relevant matches first and skips tool payloads and private reasoning.

## Run headless

`0 console --print` runs one prompt through the same engine and exits. There is no interactive terminal UI; `0 console` without a prompt prints a pointer to the browser app.

```bash
0 -p "Review the selected repository" --mode standard
0 console --print "Summarize the open findings" --format json
printf '%s' 'Summarize the selected findings' | 0 console --print
```

`0 -p` is short for `0 console --print`. Useful options:

| Option | Effect |
| --- | --- |
| `--format <text\|json\|ndjson>` | Output format. Default `text`. |
| `-m, --model <id>` | Model to use. |
| `--mode <mode>` | `standard`, `recon`, `copilot` or `yolo`. Default `yolo`. |
| `--target <url>`, `--scope <file>` | Target and scope policy for the run. |
| `--finding <id>`, `--finding-intent <intent>` | Focus on one saved finding: `investigate`, `verify`, `draft_fix` or `impact`. |
| `--max-tool-calls <n>` | Tool-call rounds per message. Unlimited by default. |
| `--resume <id>`, `--continue` | Continue a saved mission by id or prefix, or the most recent one. `0 -r <id>` and `0 -c` are shortcuts. |

Headless runs have no approval dialog. A task that needs a human decision cannot finish there; open it in the browser.

### Continue a live mission from the terminal

Send a prompt to a mission that is open on a running engine:

```bash
0 console --chat <id> --print "Summarize the retained findings" --format json
0 console --chat <id> --engine staging --print "Continue the investigation" --format ndjson
```

The mission keeps its own model, scope and mode, so local `--model`, `--mode`, `--target` and `--scope` flags are rejected. Pending decisions are reported, not approved. JSON prints one result; NDJSON prints engine events, then the result.

Manage live missions with `0 chats list`, `show`, `create`, `send`, `continue`, `cancel`, `force-stop` and `events`. `0 chats cancel <id>` requests a stop; the mission reports `cancelling` until its work drains. See [Remote engines and teams](/engines/) for `--engine`.

### Drive a running app from scripts

`0 api` calls the app's backend HTTP API with the engine's normal authentication and approval checks. Keep the token in an environment variable, not on the command line:

```bash
export ZERO_AGENT_TOKEN="$(openssl rand -hex 32)"
0 web --no-open --port 48123 --engine-token-env ZERO_AGENT_TOKEN --ready-json

# From another shell with the same token variable:
0 api /api/console/sessions --engine-url http://127.0.0.1:48123 --engine-token-env ZERO_AGENT_TOKEN
```

The default method is `GET`. Use `--method` and `--data <json-or-@file>` (at most 1 MB) for writes. Responses look like `{ "ok": true, "status": 200, "data": ... }`. Exit code 0 means the request succeeded, not that a queued operation finished; poll the resource to check.

## Limits

- **Local** means tools run on the engine host. Your model endpoint can still be remote. Where tools run and which model you use are separate choices.
- A provider connection does not authorize a target. Scope and tool isolation are separate.
- A source build serves the app from built assets. Rebuild after changing source.
