---
title: Concepts
description: The terms 0 uses in the browser app, the CLI and these docs.
---

0 uses one small vocabulary everywhere. Learn these nine terms and the rest of the docs read faster.

| Term | Meaning |
| --- | --- |
| **Mission** | A conversation with the agent in the browser app. You describe a job; the agent plans it, runs tools and reports back. The CLI calls these chats (`0 chats`, `0 console`). See [Browser app](/app/). |
| **Scan** | One assessment of one target. Modules: `web`, `source`, `package`, `deep`, `repair` and `campaign`. See [Scan code](/scan-code/) and [Scan web and APIs](/scan-web/). |
| **Finding** | An issue with evidence. An unconfirmed finding is a **lead**. See [Findings](/findings/). |
| **Run** | One execution of a scan or an automation, with its own report. |
| **Automation** | A saved list of steps that runs by hand, on a trigger or on a schedule. Starter automations are templates. See [Automations](/automations/). |
| **Sentinel** | A standing agent with a scope, an autonomy level and a daily budget. It runs missions on a schedule, on a pull request or by hand. See [Sentinels](/sentinels/). |
| **Plugin** | Anything that extends 0: tools, skills, agents or themes. See [Plugins](/plugins/). |
| **Skill** | A folder of instructions the agent loads when a task needs it. A skill is one kind of plugin. See [Skills](/skills/). |
| **Engine** | The process that does the work, on this computer or a remote server. See [Remote engines and teams](/engines/). |

## How they fit together

- A mission, a scan, an automation or a sentinel produces runs.
- Runs produce findings.
- You verify a finding, then fix it.
- Plugins and skills extend what the agent can do.
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
