---
title: Concepts
description: The terms 0 uses in the browser app, the CLI and these docs.
---

0 uses one small vocabulary everywhere. Commands, flags and API routes keep older internal names; the table notes where they differ. Chat slash commands use the CLI words too: `/threads start` is `0 threads send new`.

| Term | Meaning |
| --- | --- |
| **Thread** | A conversation with the agent. You describe a job; the agent plans it, runs tools and records findings. Threads can be saved, resumed and archived. The CLI manages them with `0 threads` (the old command names still work); URLs and the API say chats and sessions (`/chats/<id>`, `--chat`). See [Browser app](/app/). |
| **Scan** | One assessment of one target. Modules: `web`, `source`, `package`, `deep`, `repair` and `campaign`. See [Scan code](/scan-code/) and [Scan web and APIs](/scan-web/). |
| **Finding** | A security issue with evidence. An unconfirmed finding is a **lead**. See [Findings](/findings/). |
| **Report** | The result of one run of a scan or an automation: status, evidence and linked findings. It opens at `/runs/<id>`; the CLI calls it a run (`0 lab runs`). |
| **Automation** | A saved list of steps that runs by hand, on a trigger or on a schedule. Starter automations are templates. See [Automations](/automations/). |
| **Agent** | A persistent agent with a name, a standing job, a scope, files, a schedule and a daily budget. It runs threads on a schedule, on a pull request or by hand. See [Agents](/agents/). |
| **Limits** | There is one mode: a thread or Agent has shell access. It is limited by its scope, its budget (cost ceiling and time cap), the optional sandbox and the one global setting **Ask before running commands**, off by default. Older stored access values still load and mean the same mode. |
| **Helper** | A helper agent a thread starts for a part of its work (a subagent). Limits live under Settings, Helpers. |
| **Scope** | What a scan or Agent may target: the target list or URL on an automation or Agent, with its exclusions. It is optional and enforced by the scope extension. Your chosen folder is always allowed. See [Scope and authorization](/scope/). |
| **Plugin** | Installable code that extends 0: a tool plugin or an MCP server plugin. A plugin can bundle skills. See [Plugins](/plugins/). |
| **Skill** | A folder of instructions the agent loads when a task needs it. A skill is not code. See [Skills](/skills/). |
| **Theme** | A light and dark color palette for the browser app. Themes live in the browser only. See [Browser app](/app/#themes). |
| **Memory** | Source-backed notes the agent saved and can recall. See [Browser app](/app/#memory). |
| **Computer** | The machine where threads run and tools execute: this one, a VM or a remote server. See [Computers and teams](/engines/). |

## How they fit together

- A thread drives the work: ask the agent to start a scan, edit an automation or open a report.
- A scan or an automation produces a report, and the report links its findings.
- Agents run threads on their own and file reports.
- Scope decides which targets may be tested live.
- You verify a finding, then fix it.
- Plugins add tools and MCP servers, skills add instructions, themes change only how the app looks.
- A computer runs all of it. The browser app, the CLI, CI and MCP are different ways to drive the same computer.

## Pick an entry point by target

| Target | Start with | Guide |
| --- | --- | --- |
| Source repository | `0 scan ./repo` | [Scan code](/scan-code/) |
| npm, PyPI, Cargo package or OCI image | `0 scan <eco>:<name>` | [Scan code](/scan-code/) |
| Project dependencies | `0 scan . --module deps` | [Dependencies](/dependencies/) |
| Web app, REST API or MCP endpoint | `0 scan <url> --scope ./scope.json` | [Scan web and APIs](/scan-web/) |
| A finding you want reproduced or patched | `0 scan verify`, `0 scan fix`, `0 scan <path> --module repair` | [Verify and fix](/verify-and-fix/) |
| Binaries, kernels, identity, AI agents | `0 lab research ...`, `0 scan eval`, `0 scan agent-assure` | [Specialist research](/research-workflows/) | <!-- docs-check: allow-moved -->

`0 <target>` with no command picks a module for you: a URL becomes `scan web`, a local path becomes `scan source`, and a package name becomes `scan package`.

Live testing needs authorization. Source review can run tools, download dependencies and send code to your model provider. Read [Scope and authorization](/scope/) before you scan a live target.
