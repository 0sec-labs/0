---
title: Threads
description: Run a job in the browser app, from the terminal or headless.
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

The sidebar holds **New thread** and your history, **Findings**, **Skills**, **Memory**, **Computers**, **Extensions** and your **Sentinels**. Press `?` outside a text field for the keyboard shortcuts.

The composer can attach images or text files, set a thinking effort for models that support it, and takes slash commands. A message sent while the agent works is queued and goes out when the response ends; **Send now** interrupts instead, and **Stop response** stops. If a model connection drops, the thread reconnects and continues from its last completed tool result.

### Slash commands

Type `/` for a menu. Each entry mirrors a CLI command, and anything that changes or deletes asks first.

| Slash command | CLI |
| --- | --- |
| `/threads start`, `/threads list`, `/threads export` | `0 threads send new`, `0 threads list`, `0 threads list <id> --export` |
| `/findings list`, `/fix [finding-id]` | `0 findings list`, `0 threads send new` |
| `/scan <folder>` | `0 scan <folder>`; in chat it scans in this thread instead of a new one |
| `/sentinels list`, `/sentinels create` | `0 sentinels list`, `0 sentinels set --create` |
| `/computers list`, `/models list`, `/skills list`, `/memory list` | the same words after `0` |
| `/config get`, `/doctor` | `0 config get`, `0 config doctor` |

Chat-only commands are `/help`, `/status`, `/tools`, `/explain [topic]`, `/feedback <message>`, `/shortcuts` and `/usage`.

### Limits and approvals

A thread has one mode: the agent has shell access and runs commands as your user in the folder you chose. What limits it is the optional sandbox and one global setting, **Ask before running commands** under **Settings → Helpers** (off by default). When it is on, each command or change is put to you first. See [Configuration](/configuration/#ask-before-running-commands).

The agent also has a `web_search` tool (Parallel's anonymous hosted search, with DuckDuckGo as a fallback; no key needed). Results are links and snippets, not a sign that a page was read in full. `ZERO_FEATURE_WEB_SEARCH=0` turns it off by default. 
`AGENTS.md` or `CLAUDE.md` files inside a target repository are never loaded, because whoever wrote the target controls that text. Your own instructions live under **Settings → Instructions**: a global `~/.0/AGENTS.md` and one file per folder, each up to 32,000 characters.

### Saved threads

A saved thread opens at `/chats/saved/<id>` read-only, with its transcript and panels, and resumes when you send a message. Search with ⌘K; it matches message text and titles and skips tool payloads and private reasoning. **Settings → Threads** sets title instructions, idle archiving (off, 7, 14, 30 or 90 days) and the helper limits: concurrent helpers (1-128, default 32), nesting depth (1-16, default 8) and helpers per call (1-4096, default 1024).

## Memory

**Memory** is what 0 remembers across threads: short plain notes such as an accepted or rejected fix, a convention, how to run the tests, or something to avoid. Open **Memory** to list, search, add, edit and forget notes, or turn Memory off for new threads.

At the start of each turn the model reads the notes, newest first, up to about 2,000 tokens. The notes are labelled as untrusted context: they never override system rules or your request. The model has one `memory` tool with three actions: `remember`, `update` and `forget`. A repository cannot supply notes.

- **You** commit immediately: "remember that ...", `0 memory add` and the Add button save at once.
- **0** saves a note it chose to keep, unless the thread has read untrusted content (web pages, repository files, shell output, extension results). Then nothing is saved: it tells you in the thread, and you can add the note yourself.
- **Secrets**: a note that looks like a key, token or password is refused.

Notes are plain Markdown in `~/.0/memory/MEMORY.md`. Nothing is written into your repository. `ZERO_DISABLE_MEMORY=1` turns Memory off. From the terminal: `0 memory list`, `0 memory add "<note>"`, `0 memory remove <id>`.

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

`send new` creates the thread and runs one turn. `--wait` blocks until the turn ends and prints only the reply on stdout (the thread id, tokens and cost go to stderr), and exits 1 if the turn errored. `send <id> ... --wait` and `show <id> --wait` do the same for a thread that already exists. Every `0 threads` command needs a running app; without one it prints `No console running. Start one with: 0 --headless` and exits non-zero.

## Headless

`0 -p` runs one prompt through the same app process and exits.

```bash
0 -p "Review the selected folder"
0 -p "Summarize the open findings" --format json
printf '%s' 'Summarize the selected findings' | 0 -p
```

| Option | Effect |
| --- | --- |
| `--format <text\|json\|ndjson>` | Output format. Default `text`. |
| `-m, --model <id>` | Model to use. |
| `--approvals <ask\|auto>` | `ask` puts each command to you first; headless runs cannot answer, so effectful tools are refused. Default `auto`, or your `approvals` setting. |
| `--finding <id>`, `--finding-intent <intent>` | Focus on one saved finding: `investigate`, `verify`, `draft_fix` or `impact`. |
| `--resume <id>`, `--continue` | Continue a saved thread by id or prefix, or the most recent one (`0 -r <id>`, `0 -c`). |

A task that needs a human decision cannot finish headless; open it in the browser. To continue a live thread, pass `--chat <id>` (the thread keeps its own model, so `--model` is rejected; pending decisions are reported, not approved).

On a server or in CI, start the app with `0 --headless --ready-json`. It opens no browser and serves the API only. To drive a running app from scripts, `0 api` calls its backend HTTP API with the normal authentication and approval checks. Keep the token in an environment variable, for example `--engine-token-env ZERO_AGENT_TOKEN`, never on the command line.

## Commands and skills

- **The eight CLI commands** (`findings`, `threads`, `sentinels`, `skills`, `memory`, `models`, `computers`, `config`) are fixed entry points built into 0. They are not skills. In a thread, the `/` commands are a shorter list that mirrors the CLI (`/threads list` is `0 threads list`); a few exist only in chat.
- **Skills** are know-how a thread loads when a task needs it: `SKILL.md` folders, which extensions can also supply. See [Skills](/skills/).
- **Sentinels** are standing threads that wake on a schedule or a pull request. See [Sentinels](/sentinels/).
- **Verifier gate:** a skill can declare a check that the engine runs itself, so a thread cannot claim Verified without it. See [Findings](/findings/#verified-and-not-verified).

## Limits

- Local means tools run on the computer's host. Your model endpoint can still be remote; where tools run and which model you use are separate choices.
- A provider connection does not authorize a target. Tool isolation is separate.
- A source build serves the app from built assets. Rebuild after changing source.

## Next

- [Models](/models/): connect a provider and pick models per role.
- [Findings](/findings/): triage what a thread found.
- [Computers](/computers/): run threads on another machine.
