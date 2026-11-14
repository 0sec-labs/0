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

Start with [Install & first run](/getting-started/), then read [Scope & authorization](/scope/) before scanning a target.
