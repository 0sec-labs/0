---
title: Concepts
description: The terms 0 uses in the browser app, the CLI and these docs.
---

0 uses one small vocabulary everywhere. Commands, flags and API routes keep older internal names; the table notes where they differ.

| Term | Meaning |
| --- | --- |
| **Mission** | A conversation with the agent. You describe a job; the agent plans it, runs tools and records findings. Missions can be saved, resumed and archived. The CLI and API call them chats (`0 chats`, `0 console`, `--chat`). See [Browser app](/app/). |
| **Scan** | One assessment of one target. Modules: `web`, `source`, `package`, `deep`, `repair` and `campaign`. See [Scan code](/scan-code/) and [Scan web and APIs](/scan-web/). |
| **Finding** | A security issue with evidence. An unconfirmed finding is a **lead**. See [Findings](/findings/). |
| **Report** | The result of one run of a scan or an automation: status, evidence and linked findings. It opens at `/runs/<id>`; the CLI calls it a run (`0 runs`). |
| **Automation** | A saved list of steps that runs by hand, on a trigger or on a schedule. Starter automations are templates. See [Automations](/automations/). |
| **Sentinel** | A standing agent with a scope, an autonomy level and a daily budget. It runs missions on a schedule, on a pull request or by hand. See [Sentinels](/sentinels/). |
| **Scope** | The records that authorize live testing: targets, exclusions and approvals. See [Scope and authorization](/scope/). |
| **Plugin** | Installable code that extends 0: a tool plugin or an MCP server plugin. A plugin can bundle skills. See [Plugins](/plugins/). |
| **Skill** | A folder of instructions the agent loads when a task needs it. A skill is not code. See [Skills](/skills/). |
| **Theme** | A light and dark color palette for the browser app. Themes live in the browser only. See [Browser app](/app/#themes). |
| **Memory** | Source-backed lessons the agent saved and can recall. See [Browser app](/app/#memory). |
| **Engine** | The process that does the work, on this computer or a remote server. See [Remote engines and teams](/engines/). |

## How they fit together

- A mission drives the work: ask the agent to start a scan, edit an automation or open a report.
- A scan or an automation produces a report, and the report links its findings.
- Sentinels run missions on their own and file reports.
- Scope decides which targets may be tested live.
- You verify a finding, then fix it.
- Plugins add tools and MCP servers, skills add instructions, themes change only how the app looks.
- An engine executes all of it. The browser app, the CLI, CI and MCP are different ways to drive the same engine.

## Pick an entry point by target

| Target | Start with | Guide |
| --- | --- | --- |
| Source repository | `0 scan source ./repo` | [Scan code](/scan-code/) |
| npm, PyPI, Cargo package or OCI image | `0 scan package <name> --ecosystem <eco>` | [Scan code](/scan-code/) |
| Project dependencies | `0 deps scan` | [Dependencies](/dependencies/) |
| Web app, REST API or MCP endpoint | `0 scan web --target <url> --scope ./scope.json` | [Scan web and APIs](/scan-web/) |
| A finding you want reproduced or patched | `0 verify`, `0 fix`, `0 scan repair` | [Verify and fix](/verify-and-fix/) |
| Binaries, kernels, identity, AI agents | `0 research ...`, `0 eval`, `0 agent-assure` | [Specialist research](/research-workflows/) |

`0 <target>` with no command picks a module for you: a URL becomes `scan web`, a local path becomes `scan source`, and a package name becomes `scan package`.

Live testing needs authorization. Source review can run tools, download dependencies and send code to your model provider. Read [Scope and authorization](/scope/) before you scan a live target.
