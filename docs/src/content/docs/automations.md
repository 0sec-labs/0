---
title: Automations
description: Save a multi-step security job once, then run it on demand or on a schedule from the browser, the CLI or MCP.
---

An automation is a saved list of steps that runs against a target and keeps its results. Use one when you want the same job repeated, scheduled or handed to a pipeline.

## Run one

In the browser:

1. Run `0` and open **Automations**.
2. Pick a template, or describe a custom automation in a thread.
3. Set a target and press **Run**.

From the CLI:

```bash
0 agents list --automation --templates
0 agents run --automation --template repository-review --revision 1 \
  --target /absolute/path/to/repo \
  --workspace /absolute/path/to/repo \
  --time-cap 600000 --cost-cap 5 --format json > run.json
```

Open the report from **Findings**, or at `/runs/<id>` in the browser app.

## Vocabulary

- **Template**: a versioned starter definition.
- **Automation**: a saved definition you can edit and pin by revision.
- **Run**: one execution with its step results, findings and evidence.

Scan steps use the model connection you set up in [Models and keys](/models/). The model of a coding agent that calls 0 over MCP does not configure it.

## Edit and schedule in the browser

- Select a step in **Steps** to edit its instructions, tools and limits.
- **Definition** shows the saved JSON. Copy it to keep a version in git or import it into another workspace.
- **Triggers** sets an hourly, daily or weekly schedule.

A schedule fires only while the browser server and its computer connection are running. Stopping the server stops the scheduler.

## Discover and inspect

```bash
0 agents list --automation --format json
0 agents list --automation --template repository-review
0 agents list AUTOMATION_ID
```

These commands never start a scan. Definitions and run history live in the control database. `--db-path /absolute/path/control.db` selects another one.

## Create and edit from the CLI

Everything the editor does is available through the `--automation` flag of `0 agents list`, `run` and `set` (`set --automation create|edit|duplicate|delete|triggers`). Without a running engine they edit the control database directly; schedules need the engine. Add `--json` for machine output.

```bash
0 agents set --automation create --template repository-review --name "Weekly review" --target /absolute/path/to/repo
0 agents set --automation duplicate AUTOMATION_ID
0 agents set --automation edit AUTOMATION_ID --file ./definition.json
0 agents set --automation versions AUTOMATION_ID
0 agents set --automation rollback AUTOMATION_ID --revision 2
0 agents set --automation triggers list AUTOMATION_ID
0 agents set --automation triggers enable TRIGGER_ID --yes
0 agents set --automation delete AUTOMATION_ID --yes
```

`delete`, `triggers remove` and `triggers enable` need `--yes`. Schedules are created in the editor, where the schedule and its first review are set.

## Run from the CLI

Run a template without saving a copy, or run a saved automation pinned to a revision:

```bash
0 agents run --automation AUTOMATION_ID --revision 3 \
  --target https://target.example.com \
  --scope /absolute/path/to/scope.json --format json > run.json
```

| Flag | Meaning |
| --- | --- |
| `--template <id>` | Run a template instead of a saved automation. |
| `--revision <n>` | Require this revision of the automation or template. |
| `--target <target>` | Target to bind. A template needs one. A saved automation may carry a default. |
| `--workspace <path>` | Workspace for local execution. |
| `--scope <path>` | [Scope](/scope/) JSON file. |
| `--model <model>` | Model from your configured connection. |
| `--inputs <path>` | JSON object of artifact inputs. |
| `--time-cap <ms>` | Time cap for the whole run. |
| `--cost-cap <usd>` | Estimated cost cap for the whole run. |
| `--allow-apply` | Allow supported patch-apply steps. |
| `--chat <id>` | Attach the run to an existing thread on the selected computer. |

The command stays in the foreground. Ctrl-C cancels the run. Cost accounting is an estimate, so in-flight calls can pass the cap before 0 stops more work.

Exit codes: a completed run exits `0` even when it found something. Execution failure exits `2`. Cancellation exits `130`. Read the findings and evidence in the JSON, not only the exit code. The `scan source` and `scan web` shortcuts keep their own CI convention and can exit `1` on findings.

### Inputs

`--inputs` binds artifacts for typed steps, such as a finding to verify. The file is read up to 256 KiB. The parsed object is limited to 32 KiB, 20 nesting levels and 10,000 items. Its fields are data, not instructions or authorization. When you run through the VM CLI, keep the file inside the workspace and use workspace-relative paths inside it.

### Applying patches

Applying a patch needs `--allow-apply` on the foreground command and approval of the exact candidate that process created. A saved fix step set to apply does not grant write access. A candidate from another invocation cannot be applied. A candidate is not proof that it fixes the finding. See [Verify and fix](/verify-and-fix/).

## Templates for source targets

| Template | Needs |
| --- | --- |
| `repository-review` | A repository path. |
| `finding-verification` | A finding (JSON, path or ID) and a replay `runner`. |
| `fix-candidate` | A finding and a `testCommand`. Produces a candidate with regression evidence. |
| `security-research` | Pipeline by default. `mobile` and passive `linux-matrix` are also supported. |
| `deep-source-review` | A local repository. Profile and review settings are optional. |

Run `0 agents list --automation --templates` for the catalog your build ships. A template whose executor or prerequisites are missing fails before launch. It never turns into a plain scan.

## Retained runs

`0 scan`, `scan fix`, `scan verify` and `lab research` also record a one-step run in the same control database.

```bash
0 lab runs list --format json
0 lab runs show RUN_ID --format json
0 lab runs cancel RUN_ID
```

Run history does not resume interrupted work. `0 lab runs resume SCAN_ID --chat SESSION_ID` resumes a persisted scan in an existing thread when the computer supports it. It does not restart an automation graph.

## Attach to a running computer

A CLI or MCP client that starts its own computer ends that computer when it exits. To work on the runs you see in the browser, attach to the web computer:

```bash
# ENGINE_TOKEN holds the engine's bearer token.
0 threads list --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN
0 agents run --automation --template repository-review --target /engine/repo \
  --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN \
  --chat SESSION_ID
```

If a web computer already owns the control database and workspace, CLI and MCP clients find it through local metadata and attach on their own. A computer that cannot be reached or authenticated is an error. The client never starts a replacement. Use `--engine production` for a registered connection (see [Computers](/engines/)). The computer supplies its own workspace, scope, model and execution profile, and targets and paths are read on that computer. A thread you name with `--chat` must already exist.

Disconnecting an attached client leaves the computer running. A foreground `automation run` still cancels on Ctrl-C.

## How steps run

- Steps run one after another in topological order, branches included.
- Earlier findings and outputs pass forward as evidence. A sibling branch does not receive them. Evidence never grants access or overrides a step's instructions.
- One deadline and one cost ledger cover the run and its scans. A step's own limits can only narrow what is left. Without run limits, 0 sums the enabled steps' limits.
- The combined report collects findings, warnings and severity counts. It does not deduplicate or add a synthesis pass.
- Partial results stay on record when later work fails or the run is cancelled.
- A template keeps its pinned catalog identity through save, edit, export and import. Launch checks the pin and target compatibility again.

## Business impact on findings

Open a finding and use **Edit business impact** to record affected customers, services and data, with a rationale. The levels are **Urgent**, **High**, **Moderate**, **Low** and **Not assessed**. Clear it when you lack the context. Your edit does not change technical severity, verification results, review gates or patch permissions.

## Next steps

- [Agents](/agents/): standing agents that run automations on triggers.
- [CI](/ci/github-action/): run 0 in a pipeline.
- [MCP](/mcp/): start the same runs from a coding agent.
