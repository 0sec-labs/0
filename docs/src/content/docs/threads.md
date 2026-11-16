---
title: Threads
description: Run a job in the browser app, from the terminal or headless, and keep what the agent learned.
---

A thread is a conversation with the agent. You describe a job in plain words; the agent plans it, reads files, runs commands and records findings. Threads are saved, can be resumed and can be archived.

```bash
0
```

`0` starts the browser app on this computer. No account is needed. It binds to `127.0.0.1:48123`.

| Flag | Default | Effect |
| --- | --- | --- |
| `--port <port>` | `48123` | Port to bind. `0` picks a free loopback port. |
| `--host <host>` | `127.0.0.1` | Loopback address to bind. |
| `--no-open` | | Start without opening a browser. |
| `--db-path <path>` | local store | SQLite database for findings and runs. |
| `--ready-json` | | Print the bound URL as JSON, for scripts. |

Run `0 --help` for the full list.

## Run a thread

1. Press **New thread**.
2. Pick a folder if the job involves code. The folder is always allowed.
3. Choose a model with the model picker under the composer. Connect a provider first if the list is empty; see [Models](/models/).
4. Describe the job, for example "Review this repo for auth bypasses and verify anything you find".
5. Watch tool activity in the transcript. Findings land in **Findings**.

The sidebar holds **New thread** and your history, **Findings**, **Skills**, **Memory**, **Computers**, **Extensions** and your **Agents**. Press `?` outside a text field for the keyboard shortcuts.

The composer can attach images or text files, set a thinking effort for models that support it, and takes slash commands. A message sent while the agent works is queued and goes out when the response ends; **Send now** interrupts instead, and **Stop response** stops. If a model connection drops, the thread reconnects and continues from its last completed tool result.

### Slash commands

Type `/` for a menu. Each entry mirrors a CLI command, and anything that changes or deletes asks first.

| Slash command | CLI |
| --- | --- |
| `/threads start`, `/threads list`, `/threads export` | `0 threads send new`, `0 threads list`, `0 threads list <id> --export` |
| `/findings list`, `/fix [finding-id]` | `0 findings list`, `0 scan fix` |
| `/agents list`, `/agents create` | `0 agents list`, `0 agents set --create` |
| `/computers list`, `/models list`, `/skills list`, `/memory list` | the same words after `0` |
| `/config get`, `/doctor` | `0 config get`, `0 config doctor` |

Chat-only commands are `/help`, `/status`, `/tools`, `/explain [topic]`, `/feedback <message>`, `/shortcuts` and `/usage`.

### Limits and approvals

A thread has one mode: the agent has shell access and runs commands as your user in the folder you chose. What limits it is the scope, its budget (cost ceiling and time cap), the optional sandbox and one global setting, **Ask before running commands** under **Settings → Helpers** (off by default). When it is on, each command or change is put to you first. See [Configuration](/configuration/#ask-before-running-commands).

The agent also has a `web_search` tool (Parallel's anonymous hosted search, with DuckDuckGo as a fallback; no key needed). Results are links and snippets, not a sign that a page was read in full. `ZERO_FEATURE_WEB_SEARCH=0` turns it off by default. It can clone a public HTTPS repository to review it; cloning does not add the host to your scope.

`AGENTS.md` or `CLAUDE.md` files inside a target repository are never loaded, because whoever wrote the target controls that text. Your own instructions live under **Settings → Instructions**: a global `~/.0/AGENTS.md` and one file per folder, each up to 32,000 characters.

### Saved threads

A saved thread opens at `/chats/saved/<id>` read-only, with its transcript and panels, and resumes when you send a message. Search with ⌘K; it matches message text and titles and skips tool payloads and private reasoning. **Settings → Threads** sets title instructions, idle archiving (off, 7, 14, 30 or 90 days) and the helper limits: concurrent helpers (1-128, default 32), nesting depth (1-16, default 8) and helpers per call (1-4096, default 1024).

## Memory

**Memory** is what 0 remembers across threads: short plain notes about a folder or about your team's decisions, such as an accepted or rejected fix, a convention, how to run the tests, or something to avoid. A note is one or two sentences, either for one folder or for everywhere. Open **Memory** to list, search, add, edit and forget notes, filter by folder, export or import them, or turn Memory off for new threads.

At the start of each turn the model reads the notes for the folder and the global ones, most recently used first, up to a budget of about 2,000 tokens. The notes are labelled as untrusted context: they never override system rules or your request, and the model checks them against the code. The model can add a note or forget one with a single `memory` tool. It never saves a note on its own from tool output or from files in your repository, and a repository cannot supply notes: nothing is read from the repository.

Notes are plain Markdown in the computer's private state: `~/.0/memory/MEMORY.md` for global notes and `~/.0/memory/<folder-hash>/MEMORY.md` for each folder. Nothing is written into your repository. You can edit these files by hand or search them with `grep`. `ZERO_DISABLE_MEMORY=1` turns Memory off. Memory is not available inside an isolated workbench.

From the terminal: `0 memory list`, `0 memory add "<note>"`, `0 memory remove <id>`, `0 memory clear --yes`, `0 memory export -o <file>` and `0 memory import <file>`. The first time Memory opens after an update, 0 copies the older stores (source lessons, hunt memory, triage memories and lessons) into notes once, and records what it did in `~/.0/memory/import-report.json`. The older files are left in place.

## From the terminal

`0 threads` does what the thread menu does, against the app started by `0`:

```bash
id=$(0 threads send new "Map the login flow" --folder ~/code/app)
0 threads list "$id" --set --effort high
0 threads stop "$id"            # --force if owned execution does not drain
0 threads send "$id" --retry
0 threads list "$id" --rename "Login flow"
0 threads list "$id" --export --format md -o login-flow.md
0 threads list "$id" --delete --yes
```

`send new` creates the thread and runs one turn. `--wait` blocks until the turn ends, prints the reply with tokens and estimated cost, and exits 1 if the turn errored. `--cost-ceiling <usd>` stops the thread once its estimated spend reaches that amount. Every `0 threads` command needs a running app; without one it prints `No console running. Start one with: 0 --headless` and exits non-zero.

## Headless

`0 -p` (short for `0 lab console --print`) runs one prompt through the same app process and exits.

```bash
0 -p "Review the selected folder" --scope scope.yaml
0 lab console --print "Summarize the open findings" --format json
printf '%s' 'Summarize the selected findings' | 0 lab console --print
```

| Option | Effect |
| --- | --- |
| `--format <text\|json\|ndjson>` | Output format. Default `text`. |
| `-m, --model <id>` | Model to use. |
| `--approvals <ask\|auto>` | `ask` puts each command to you first; headless runs cannot answer, so effectful tools are refused. Default `auto`, or your `approvals` setting. |
| `--target <url>`, `--scope <file>` | Target and scope for the run. |
| `--finding <id>`, `--finding-intent <intent>` | Focus on one saved finding: `investigate`, `verify`, `draft_fix` or `impact`. |
| `--resume <id>`, `--continue` | Continue a saved thread by id or prefix, or the most recent one (`0 -r <id>`, `0 -c`). |

A task that needs a human decision cannot finish headless; open it in the browser. To continue a live thread, pass `--chat <id>` (the thread keeps its own model and scope, so `--model`, `--target` and `--scope` are rejected; pending decisions are reported, not approved).

On a server or in CI, start the app with `0 --headless --ready-json`. It opens no browser and serves the API only. To drive a running app from scripts, `0 api` calls its backend HTTP API with the normal authentication and approval checks. Keep the token in an environment variable, for example `--engine-token-env ZERO_AGENT_TOKEN`, never on the command line.

## Commands, skills and workflows

- **The nine CLI commands** (`scan`, `findings`, `threads`, `agents`, `skills`, `memory`, `models`, `computers`, `config`) are fixed entry points built into 0. They are not skills. In a thread, the `/` commands are a shorter list that mirrors the CLI (`/threads list` is `0 threads list`); a few exist only in chat.
- **Skills** are know-how a thread loads when a task needs it: `SKILL.md` folders, which extensions can also supply. See [Skills](/skills/).
- **Workflows** today are pipeline templates run by the engine's workflow runner, with time and cost caps. An **automation** is a workflow template plus a trigger (`schedule`, `manual` or `github-pr`; a webhook only speeds up `github-pr`). An **Agent** owns automations. See [Agents](/agents/#automations).
- **Direction, not shipped:** a thread would run a skill on a target, and `scan` would become shorthand for that. A verifier gate run by the engine itself, instead of by the model, is the first slice and is in progress.

## Limits

- Local means tools run on the computer's host. Your model endpoint can still be remote; where tools run and which model you use are separate choices.
- A provider connection does not authorize a target. Scope and tool isolation are separate.
- A source build serves the app from built assets. Rebuild after changing source.

## Next

- [Models](/models/): connect a provider and pick models per role.
- [Findings](/findings/): triage what a thread found.
- [Computers](/computers/): run threads on another machine.
