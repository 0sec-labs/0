---
title: Concepts
description: The terms 0 uses in the browser, the CLI, and these docs - missions, findings, automations, sentinels, reports, scope, plugins, skills, themes, and engines.
---

0 uses one small vocabulary in the browser, the CLI, and these docs. Commands,
flags, API routes, and storage keys keep their stable internal names, which the
last column lists.

| Term | What it is | Where in the UI | Internal name (CLI, API) |
|---|---|---|---|
| **Mission** | A conversation with the agent: it reads, runs tools, and records findings. Missions can be saved, resumed, and archived. See [Missions & settings](/console/). | **Missions** (`/chats`) | `0 chats`, `0 console`, `/api/console/sessions`, `--chat`, `--resume` |
| **Finding** | A security issue with evidence. A **lead** is an unconfirmed finding. A finding has one of six states: Backlog, Todo, In progress, Blocked, Done, or Cancelled. See [Findings API](/findings-api/) and [Triage](/triage/). | **Findings** | `0 findings` |
| **Automation** | A saved, reusable multi-step process that starts by hand, on a trigger, or on a schedule. Starter automations are templates. See [Automations](/automations/). | **Automations** | `0 automation`, workflow definitions, `/api/console/workflow-definitions` |
| **Sentinel** | A standing watcher that keeps an eye on a target and reports what it finds. See [Sentinels](/sentinels/). | **Sentinels** | `/api/console/sentinels` |
| **Report** | The result of one execution of an automation or a scan: status, evidence, and linked findings. | A report page (`/runs/<id>`) | `0 runs`, `/runs/<id>` |
| **Scope** | The records that authorize live testing: targets, exclusions, and approvals. Each record is a scope. See [Scope & authorization](/scope/). | **Scope** | `--scope`, `--engagement-profile` |
| **Plugin** | Installable code that extends 0. Kinds: a tool plugin (executable tools, sandboxed and permission-gated), an MCP server plugin (third-party services such as GitHub or Slack), and later research packs. A plugin can bundle skills. See [Plugins](/plugins/). | **Plugins**, **Explore** | `0 plugin`, `/api/console/plugins`, registry path `extensions/<id>/` |
| **Skill** | A pack of instructions the agent follows when they apply. A skill is not code and is not a plugin kind. See [Skills](/skills/). | **Skills** | `SKILL.md`, `list_skills`, `load_skill` |
| **Theme** | A color palette for light and dark. Themes exist in the browser only. | **Settings → Appearance** | Browser storage only; no CLI identifier |
| **Engine** | The process that does the work, local or remote. A browser connects to an engine; teams share one. See [Engines & teams](/engine-connections/). | **Engines** (`/engines`) | `--engine`, `0 worker`, `/api/console/...` |
| **Memory** | Reusable, source-backed project notes (lessons) the agent can recall. See [Missions & settings](/console/#what-memory-remembers). | **Memory** (`/learning`) | `remember_codebase`, `ZERO_DISABLE_HUNT_MEMORY` |

## How they fit together

- A mission drives the work: ask the agent to start a scan, edit an automation, or open a report.
- A scan or an automation produces a report, and a report links the findings it produced.
- Sentinels watch on their own and file reports.
- Scope decides which targets a mission, scan, or sentinel may test live.
- Plugins add tools and MCP servers; skills add instructions; themes change only how the browser looks.
- The engine executes everything.

## What 0 can target

Choose a scan by target, then follow its setup and authorization requirements.

| Target or task | Entry point | Guide |
| --- | --- | --- |
| Web application or REST API | `scan --mode web` | [Scans](/scans/) |
| AI/LLM endpoint or MCP target | `scan` with the appropriate mode | [Commands](/commands/#scan-web) |
| Source repository | `scan source` | [Scans](/scans/) |
| Source plus a running application | `scan --repo` | [White-Box Mode](/white-box-mode/) |
| npm, PyPI, Cargo package, or OCI image | `audit --ecosystem` | [Scans](/scans/) |
| Focused source and vulnerability research | `hunt`, `scan deep`, and specialized research commands | [Research Workflows](/research-workflows/) |
| Kernel reproduction | `kernel`, `verify`, and `research` families | [Kernel VM Verification](/kernel-vm/) |
| Compiled binary evidence | `binary` and the 0verse adapter | [Research Workflows](/research-workflows/) |
| Identity and offline relationship analysis | `identity`, `adgraph`, `entragraph` | [Scope & authorization](/scope/) |
| Stateful agent assurance | `agent-assure` | [Adversarial Evals](/adversarial-evals/) |
| Candidate evaluation and promotion | `evolve` | [Improvement Plane](/improvement-plane/) |

Live network testing requires authorization and scope. Source review may execute
tools, download dependencies, and send model requests. Coverage depends on the target and available evidence.
For the implemented source-review and reverse-engineering stack, see
[Code and binary analysis](/code-and-binary-analysis/).

Start with the [quick start](https://github.com/0sec-labs/0#quick-start), then read [Scope & authorization](/scope/) before scanning a target.
