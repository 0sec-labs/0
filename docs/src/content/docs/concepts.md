---
title: Concepts
description: The seven terms 0 uses everywhere - scan, finding, automation, run, chat, plugin, and engine.
---

0 uses a small, consistent vocabulary in the CLI, the browser, and these docs.

| Term | Meaning |
|---|---|
| **Scan** | One assessment of a target. Modules: `web`, `source`, `package`, `deep`, and `repair`. See [Scans](/scans/). |
| **Finding** | An issue with evidence. A **lead** is an unconfirmed finding. See [Findings API](/findings-api/) and [Triage](/triage/). |
| **Automation** | A saved, reusable multi-step process that runs by hand or on a trigger or schedule. Starter automations are called templates. See [Automations](/automations/). |
| **Run** | One execution of a scan or an automation. |
| **Chat** | A conversation with the agent. See [Chat & settings](/console/). |
| **Plugin** | Anything that extends 0: a tool, skill, agent, or theme. See [Plugins](/plugins/). |
| **Engine** | The process that does the work, local or remote. See [Engine connections](/engine-connections/). |

## How they fit together

- A scan or an automation produces a run.
- A run produces findings.
- Plugins extend what runs can do.
- The engine executes runs.
- Chats drive it all: ask the agent to start a scan, edit an automation, or inspect a run.

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
| Identity and offline relationship analysis | `identity`, `adgraph`, `entragraph` | [Scope & authorization](/scope/#authorized-engagements) |
| Stateful agent assurance | `agent-assure` | [Adversarial Evals](/adversarial-evals/) |
| Candidate evaluation and promotion | `evolve` | [Improvement Plane](/improvement-plane/) |

Live network testing requires authorization and scope. Source review may execute
tools, download dependencies, and send model requests. Coverage depends on the target and available evidence.
For the implemented source-review and reverse-engineering stack, see
[Code and binary analysis](/code-and-binary-analysis/).

Start with [Install & first run](/getting-started/), then read [Scope & authorization](/scope/) before scanning a target.
