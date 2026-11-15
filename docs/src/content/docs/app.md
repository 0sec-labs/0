---
title: Browser app
description: Run threads, review findings, change settings and themes in the local browser app, or run the same app headless.
---

```bash
0
```

`0` (or `0 web`) starts the app on this computer. No account is needed. It binds to `127.0.0.1:48123` by default.

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

- **New thread**, search and your thread history.
- **Findings**, with a count of open findings.
- **Automations**.
- **Skills**: **Installed** skills, and **Browse** for the GitHub skills directory and **Add from GitHub**.
- **Memory**.
- **Computers**: the machines threads run on. Always listed; it is no longer under Settings.
- **Explore**: the catalog of **Plugins** and **Themes**.
- Your **Agents**, when this computer supports them.

Two cards can appear above the account row, for local users and team owners:

- **Finish setting up** has two steps: connect a model provider and start your first thread. It hides once both are done, and you can dismiss it.
- **Update available** shows the latest and current versions. **Copy update command** copies `0 doctor upgrade`. Dismissing it hides that version only.

### Keyboard shortcuts

Press `?` outside a text field to see every shortcut, or open **Settings → Shortcuts** for a searchable list. On Linux and Windows, use Ctrl instead of ⌘.

| Shortcut | Action |
| --- | --- |
| ⌘K or `/` | Search anything |
| ⌘, | Open Settings |
| ⌘B or ⇧⌘S | Show or hide the sidebar (⌘B is bold while typing) |
| ⇧⌘B | Show or hide the right panel in a thread |
| ⇧⌘O | New thread |
| ⌘. | Stop the running thread |
| ⌘I | Focus the composer |
| ⌘/ | Attach files |
| ⇧⌘F, ⇧⌘E, ⇧⌘G, ⇧⌘L, ⇧⌘V | Open Findings, Evidence, Fixes, Browser or Visuals in the thread panel |
| Enter, ⇧Enter | Send, or insert a new line |

## Run a thread

1. Press **New thread**.
2. Pick a folder if the job involves code.
3. Choose a model with the model picker under the composer. Connect a provider first if the list is empty; see [Models and keys](/models/).
4. Describe the job in plain words, for example "Review this repo for auth bypasses and verify anything you find".
5. Watch tool activity and agents in the transcript. Findings land in **Findings**.

The composer also has:

- **Add to message**: attach images or text files, or reference a file path.
- **Thinking effort**, for models that support it.
- **Mode**: whether the agent asks before it acts. See below.
- Slash commands. Type `/` to list them. They are the CLI commands: `/threads start` is `0 threads start`. See [Slash commands](#slash-commands).

### Slash commands

Type `/` in the composer for a menu grouped by command. Each entry shows the CLI command it mirrors, so the same words work in chat and in a terminal. Filter by typing, move with the arrow keys, press Enter or Tab to fill in the command, then Enter to run it. Escape closes the menu.

| Slash command | CLI | What it does here |
| --- | --- | --- |
| `/threads start` | `0 threads start` | Starts a new thread |
| `/threads list` | `0 threads list` | Opens the thread list |
| `/threads export`, `/copy` | `0 threads export` | Exports this thread |
| `/threads close` | `0 threads close` | Closes this thread after you confirm |
| `/clear` | `0 threads clear` | Clears this thread after you confirm |
| `/findings list`, `/findings export` | `0 findings list`, `0 findings export` | Opens Findings |
| `/fix [finding-id]` | `0 scan fix` | Opens the fix flow; you approve any pull request |
| `/agents list`, `/agents create` | `0 agents list`, `0 agents create` | Opens Agents |
| `/automation list`, `/automation run` | `0 automation list`, `0 automation run` | Opens Automations; running asks you to confirm |
| `/computers list` | `0 computers list` | Opens Computers |
| `/models list` | `0 models list` | Opens Models |
| `/models default [model]` | `0 models default` | Shows the default model, or switches this thread's model |
| `/models connections` | `0 models connections` | Opens Connections to add a key or sign in |
| `/models usage`, `/usage` | `0 models usage` | Shows tokens, cost and context |
| `/skills list` | `0 skills list` | Opens Skills |
| `/memory list` | `0 memory list` | Opens Memory |
| `/plugin list`, `/plugin browse` | `0 plugin list`, `0 plugin browse` | Opens Plugins or the plugin explorer |
| `/config list`, `/config get`, `/config set` | `0 config list`, `0 config get`, `0 config set` | Opens Settings; changes are made there |
| `/doctor` | `0 doctor` | Checks your setup |

Chat-only commands have no CLI form: `/help`, `/status`, `/tools`, `/explain [topic]`, `/feedback <message>`, `/theme [light|dark]` and `/shortcuts`.

Slash commands never skip a confirmation. Anything that changes or deletes asks you first, exactly as the page does. `0 scan`, `0 api` and `0 web` are CLI-only. Old names still work: `/new-mission`, `/sessions`, `/history`, `/connect`, `/plugins`, `/settings`, `/model`, `/keybindings` and `/exit` map to their new commands.

### Modes

| Mode | CLI name | Behavior |
| --- | --- | --- |
| **Act without asking** | `yolo` | Runs tools without per-action prompts. The default for new threads. |
| **Ask before acting** | `standard` | Asks you to approve each action. |

Switching to **Act without asking** also resumes actions waiting for approval. Scope grants, folder grants and questions the agent asks you stay separate decisions. Existing threads keep their mode until you change it. Credential, private-network and sandbox protections apply in both modes.

### Sending while the agent works

A message you send during a response is queued. It goes out when the current response finishes, so the agent's work is kept. Press **Send now** on a queued message to interrupt and send it at once. Press **Stop response** to stop.

Background agents that a thread starts keep running after its response ends. Stop them from the agents panel. They belong to the live thread and do not survive a computer restart.

If a model connection drops, the thread reconnects and continues from its last completed tool result. Completed tool actions are not replayed.

### Web search

The agent has a `web_search` tool and decides when to use it. Queries go to [Parallel's anonymous hosted search](https://parallel.ai/mcp), with DuckDuckGo as a fallback. No search key is needed. Results are links and snippets, not proof a page was read in full.

Set `ZERO_FEATURE_WEB_SEARCH=0` on the computer to turn search off by default. This controls the search tool only, not all network access.

### Public source

With **Act without asking**, the agent can clone a public HTTPS repository to review it. Cloning does not add the hosting service to your scope. Scope exclusions and private-network restrictions still apply. See [Scope and authorization](/scope/#local-workflows-and-strict-scope-mode).

### Access programs

The **Daybreak** control next to the model settings requests an OpenAI cyber access program (**Daybreak Blue** or **Daybreak Red**) for eligible OpenAI and ChatGPT Codex connections. **Automatic** clears the request. See [Models and keys](/models/#cyber-access-programs).

## Memory

**Memory** holds notes the agent saved while reading source code. Each entry records its folder and supporting files with content fingerprints. Before an entry is reused, 0 checks those files. If a file changed or is missing, the entry is skipped.

- Open **Supporting files** on an entry to see its evidence.
- Press **Stop using** to keep an entry out of future context. The record stays for inspection.

Memory entries are hints for the agent to check again, not verified findings. A finished thread does not become an entry on its own. Memory lives in the computer's private state, outside your repository, and are sent to your model as context when recalled. Set `ZERO_DISABLE_HUNT_MEMORY=1` on the computer to turn source memory off.

## Visualizations

The agent can put a visual in a thread with its `visualize` tool: an attack path, an incident timeline or a table of findings. Visuals are saved with the thread and replay when you reopen it.

| `kind` | Use for |
| --- | --- |
| `graph`, `attack-graph` | Nodes and edges (hosts, services, identities, vulnerabilities, steps) with optional severity. Layouts: layered, force, radial. |
| `chart` | `bar`, `line`, `area`, `pie` or `stacked`. |
| `timeline` | Dated events. |
| `table` | Columns and rows. |
| `mermaid` | Sequence or flow diagrams. |

Every visual has a title and a summary. The summary is the alt text and states the conclusion. A thread holds up to 200 visuals. A visual that is too large fails validation and the model retries with less data; nothing is truncated silently.

Visuals are plain data, never HTML. Markup, URLs and control characters are rejected. A node can reference a finding, a file or an agent, never a URL. The app sanitizes Mermaid. Target content is attacker-controlled, so the agent is told to shorten labels and not copy target text.

## Saved threads

A saved thread opens at `/chats/saved/<id>` in the same view as a live one, with its transcript, work log and panels. Opening it does not start any work. It stays read-only until you send a message, which resumes it. Rename, clear, close and model change wait until then.

Use thread history or ⌘K search to find older work. Search matches message text and metadata, ranks relevant matches first and skips tool payloads and private reasoning.

## Settings

Open **Settings** (⌘,). The search box looks inside pages as well as at their titles.

| Group | Page | What it controls |
| --- | --- | --- |
| Preferences | **General** | Update policy, input behavior, privacy (usage metrics and problem reports), support, status and one reset for shared preferences. |
| | **Appearance** | Theme, mode, accent color, font size and reduce motion. This browser only. |
| | **Threads** | Summarizing long threads, title instructions, idle archiving, subagent limits, transcript options and one **Show cost and usage** switch. |
| | **Notifications** | Browser notifications. This browser only. |
| | **Shortcuts** | The searchable shortcut list. |
| Agent | **Instructions** | Your own `AGENTS.md` text for every thread, plus one file per folder. |
| | **Models** | **Providers** (keys and sign-ins, see [Models and keys](/models/)), the default model and per-role models. |
| | **Agents** | Agent collaboration and messages, model-authored plugins and where tools run. |
| | **Git and pull requests** | The GitHub connection, reachable repositories and the pull requests this computer opened. |
| Activity | **Usage** | Estimated spend and tokens by model and by thread. |
| | **Audit log** | Approvals, denials, settings, plugin and provider changes. Searchable, with JSON export. |
| | **Members** | Team mode only. |

The folder and permissions page opens at `/project`. Checks that the computer, provider and tools work open from **General → Status → Details** (`/doctor`).

### Themes

**Settings → Appearance → Theme** opens the theme gallery. **Explore → Themes** shows the same gallery. Themes: Zero (the default), Dracula, Nord, Solarized, Catppuccin, Tokyo Night, Rosé Pine, One, GitHub and Gruvbox. Each has a light and a dark variant.

- **Mode**: System, Light or Dark. New browsers start on Dark.
- **Accent color**: orange, blue, green, violet, rose or neutral. Only the Zero theme takes an accent; other themes bring their own.
- **Font size**: Small, Default or Large.
- **Reduce motion**: System, On or Off.

Themes are stored in the browser. The computer and the CLI never see them.

### Thread settings

- **Messages while working**: queue your next message or interrupt the response.
- **Thread title instructions**: guidance for automatic titles, such as a language or style, up to 500 characters. Credentials are still redacted.
- **Archive idle threads after**: Off, 7, 14, 30 or 90 days. Runs when the computer starts. Archived threads stay searchable.
- **Concurrent subagents** (1-128, default 32), **Nested subagent depth** (1-16, default 8) and **Subagents per call** (1-4096, default 1024). `ZERO_SUBAGENT_CONCURRENCY`, `ZERO_SUBAGENT_MAX_DEPTH` and `ZERO_SUBAGENT_MAX_FANOUT` override them. A project may only lower them. See [Configuration](/configuration/).

### Operator instructions

**Settings → Instructions** edits two Markdown files you own, each up to 32,000 characters:

- **Global**: `~/.0/AGENTS.md`, for every thread.
- **Folder**: one file per folder under `~/.0/workspaces/`.

When a thread starts, both are added to its system prompt in a block marked as trusted operator instructions, global first. `AGENTS.md` or `CLAUDE.md` files inside a target repository are never loaded. Whoever wrote the target controls that text.

### Notifications

Turn on **Notify me** to get browser notifications when a thread finishes, needs your approval or asks a question, when a scan finishes, and when a fix is ready or a pull request opens. Notifications are off by default. By default they fire only while the tab is hidden and play a sound. Your browser must allow notifications. Nothing leaves the browser.

### Git and pull requests

The **GitHub** card shows who is connected (`Connected as <user> via GitHub CLI`), what is missing (`Needs permissions: repo`) or `Not connected`, and the computer it applies to. Everything runs on that computer through the GitHub CLI (`gh`). 0 never reads, stores or sends a token to the browser.

Connect with one of these, in this order:

1. **GitHub CLI login.** If `gh auth status` is already signed in on the computer, 0 uses it. A login without the `repo` scope shows `gh auth refresh -s repo` and an **Update permissions** button.
2. **Sign in with GitHub.** Runs `gh auth login --web --scopes repo,read:org` on the computer, shows the one-time code and an **Open GitHub** button, and ends after five minutes or on **Cancel**. If `gh` is missing the card shows `brew install gh` and a link.
3. **Fine-grained token.** **Create token on GitHub** opens a prefilled token page (contents and pull requests: write, metadata: read). Paste it; GitHub CLI checks it before it is saved, and the expiry is shown when GitHub reports one.

A login from `GH_TOKEN` or `GITHUB_TOKEN` is shown as `via token`.

The page also lists the repositories the account can reach (cached for five minutes) and the agents that use them. A published fix goes to a new branch and opens a pull request against the repository's current branch. 0 does not track whether a pull request is merged.

## Run headless

`0 lab console --print` runs one prompt through the same app process and exits. There is no interactive terminal UI; `0 lab console` without a prompt prints a pointer to the browser app.

```bash
0 -p "Review the selected repository" --mode standard
0 lab console --print "Summarize the open findings" --format json
printf '%s' 'Summarize the selected findings' | 0 lab console --print
```

`0 -p` is short for `0 lab console --print`. Useful options:

| Option | Effect |
| --- | --- |
| `--format <text\|json\|ndjson>` | Output format. Default `text`. |
| `-m, --model <id>` | Model to use. |
| `--mode <mode>` | `standard`, `recon`, `copilot` or `yolo`. Default `yolo`. |
| `--target <url>`, `--scope <file>` | Target and scope policy for the run. |
| `--finding <id>`, `--finding-intent <intent>` | Focus on one saved finding: `investigate`, `verify`, `draft_fix` or `impact`. |
| `--max-tool-calls <n>` | Tool-call rounds per message. Unlimited by default. |
| `--resume <id>`, `--continue` | Continue a saved thread by id or prefix, or the most recent one. `0 -r <id>` and `0 -c` are shortcuts. |

Headless runs have no approval dialog. A task that needs a human decision cannot finish there; open it in the browser.

### Continue a live thread from the terminal

Send a prompt to a thread that is open in a running app:

```bash
0 lab console --chat <id> --format json \
  --print "Summarize the retained findings"
0 lab console --chat <id> --engine staging --format ndjson \
  --print "Continue the investigation"
```

The thread keeps its own model, scope and mode, so local `--model`, `--mode`, `--target` and `--scope` flags are rejected. Pending decisions are reported, not approved. JSON prints one result; NDJSON prints computer events, then the result.

Manage live threads with `0 threads list`, `show`, `create`, `send`, `continue`, `cancel`, `force-stop` and `events`. `0 threads cancel <id>` requests a stop; the thread reports `cancelling` until its work drains. See [Computers and teams](/engines/) for `--engine`.

### Manage threads from the terminal

`0 threads` does what the thread menu does, against the app started by `0 web`:

```bash
id=$(0 threads start "Map the login flow" --folder ~/code/app --mode recon)
0 threads set "$id" --effort high
0 threads stop "$id"            # --force if owned execution does not drain
0 threads retry "$id"
0 threads rename "$id" "Login flow"
0 threads export "$id" --format md -o login-flow.md
0 threads delete "$id" --yes
```

`start --wait` blocks until the turn ends and prints the reply. `clear` and `delete` need `--yes`. Every command takes `--json`. Exit code 0 means success, 1 means the request failed, 2 means a usage error. A remote token cannot change settings the browser protects.

### Drive a running app from scripts

`0 api` calls the app's backend HTTP API with the computer's normal authentication and approval checks. Keep the token in an environment variable, not on the command line:

```bash
export ZERO_AGENT_TOKEN="$(openssl rand -hex 32)"
0 web --no-open --engine-token-env ZERO_AGENT_TOKEN --ready-json

# From another shell with the same token variable:
0 api /api/console/sessions \
  --engine-url http://127.0.0.1:48123 --engine-token-env ZERO_AGENT_TOKEN
```

The default method is `GET`. Use `--method` and `--data <json-or-@file>` (at most 1 MB) for writes. Responses look like `{ "ok": true, "status": 200, "data": ... }`. Exit code 0 means the request succeeded, not that a queued operation finished; poll the resource to check.

## Limits

- **Local** means tools run on the computer host. Your model endpoint can still be remote. Where tools run and which model you use are separate choices.
- A provider connection does not authorize a target. Scope and tool isolation are separate.
- A source build serves the app from built assets. Rebuild after changing source.

## Next

- [Models and keys](/models/): connect a provider and pick models per role.
- [Findings](/findings/): triage what a thread found.
- [Computers and teams](/engines/): run the computer on another machine.
