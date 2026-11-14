---
title: Automations
description: Create reusable security automations in the browser, CLI, or MCP.
---

A template is a starter definition. An automation is a saved, reusable definition of steps.
A run captures one execution and its results. CLI, browser, and MCP adapters use
the shared automation runner; scan steps use 0's configured model runtime.
Configure your provider before starting scans. The external coding agent's
model chat does not configure 0's provider.

## In the browser

Run `0 web` and open **Automations**. Choose a template or describe a custom automation
in a mission. Select a step in **Steps** to edit its instructions, tools, and limits.
**Definition** lets you inspect and copy the saved JSON to keep a version in git
or import it into another workspace.

Set a target and use **Run** for a single execution. Use **Triggers** to configure
hourly, daily, or weekly schedules. An enabled schedule needs a running
browser server and a working engine connection; closing the server stops its scheduler.
Review results in **Findings**; a scan's report opens at `/runs/<id>`.

## Prioritize findings

The browser's **Findings** list sorts by severity by default; **Newest** sorts
by time. Open a finding for its evidence, history, and review actions.

Use **Edit business impact** in the detail page to record affected customers,
services, data, and the rationale. Its separate labels are **Urgent**, **High**,
**Moderate**, **Low**, and **Not assessed**. Clear the assessment when business
context is missing. A technical severity or CVSS score alone does not establish
business impact.

Operator edits are retained as provided assessments. They do not change
technical severity, verification results, review gates, or patch permissions.

## Discover and inspect

```bash
0 automation list --format json
0 automation list --templates --format json
0 automation show --template repository-review
0 automation show AUTOMATION_ID
```

Discovery does not execute scans. Saved definitions and run history live in
the control database; `--db-path /absolute/path/control.db` selects that database.

## Execute

Execute a template directly without saving an automation copy:

```bash
0 automation run --template repository-review --revision 1 \
  --target /absolute/path/to/repo \
  --workspace /absolute/path/to/repo \
  --time-cap 600000 --cost-cap 5 --format json > run.json
```

Execute a saved automation with a pinned revision:

```bash
0 automation run AUTOMATION_ID --revision 3 \
  --target https://target.example.com \
  --scope /absolute/path/to/scope.json --format json > run.json
```

Select one saved automation ID or `--template`. `--revision` pins either selector. Saved automations may supply a
default target; a template needs `--target`. `--model` selects a model through
0's configured provider. Time caps are milliseconds and cost caps are USD,
and apply across the automation. Cost accounting is estimated; in-flight calls may
exceed the ceiling before recorded usage stops additional work. Scope and target
compatibility are checked by the shared runtime.

The command stays in the foreground until the run finishes. Ctrl-C cancels its
owned execution. JSON contains the retained run and actual results, including
step statuses and evidence references. A completed run exits successfully even
when findings exist. Execution failure exits with code 2; cancellation exits
with code 130. Consumers should inspect findings and evidence separately from
the execution status.

## Artifact inputs and patch permission

Use `--inputs /absolute/path/inputs.json` to bind runtime artifacts for typed
steps. The file read limit is 256 KiB. The parsed JSON object must fit the shared
32 KiB value limit, 20 nesting levels, and 10,000 visited items. Its fields are
data for the chosen executor, not instructions or authorization. A saved step's
explicit bindings can select a finding, scan, database, or earlier step output.
The runtime validates those references against the authorized target and workspace.
For VM CLI execution, keep the inputs file inside the selected workspace and use
workspace-relative paths inside its JSON. The bridge maps the file path; it does
not rewrite arbitrary JSON values.

Patch application requires `--allow-apply` on the foreground command. This grants
both the host permission and the run request permission; portable automation JSON
cannot grant either. A saved fix step's apply mode alone does not authorize writes. Application also
requires approval of the exact live candidate owned by that process; a retained
candidate ID from another CLI invocation is insufficient.
Fix candidates and applied patches retain their own verification status; creating
a candidate does not prove that it fixes the finding.

```bash
0 automation run AUTOMATION_ID --target /absolute/path/to/repo \
  --workspace /absolute/path/to/repo --inputs /absolute/path/inputs.json \
  --format json > run.json
```

The catalog includes these specialized templates for local source targets:

| Template | Required bindings |
|---|---|
| `finding-verification` | A finding JSON/path/ID or connected finding, and an explicit replay `runner` |
| `fix-candidate` | A finding and `testCommand`; produces a candidate with regression evidence |
| `security-research` | Pipeline by default; `mobile` and passive `linux-matrix` are supported engines |
| `deep-source-review` | Local repository; optional profile and review settings |

Managed live Linux boot research cannot launch until its VM/build engine supports
automation cancellation. Existing kernel verification keeps its own wall-clock
controls. Run completion and the reproduced, fixed, or hypothesis verdict remain
separate fields in the retained outputs.

## Retained runs and engine lifetime

The existing `0 scan source`, `0 scan`, and `0 scan package` shortcuts execute one-step
scan automations and retain their run snapshots and results in the same
control database. The `fix`, `verify`, `research`, and `scan deep` command
shortcuts also retain one-operation runs through the shared runner. `scan package` is the package scan shortcut. These shortcuts
preserve their established output and CI exit conventions: for example,
`scan source` can exit with code 1 for findings while `automation run` exits with code 0
for a completed execution containing findings. Inspect the retained run status
and evidence to distinguish findings from an execution failure.


```bash
0 runs list --format json
0 runs show RUN_ID --format json
```

Run history does not implicitly resume interrupted work. An embedded CLI or MCP
engine runs the same mission and automation services as the web server; closing that
engine ends its execution lifetime. Attach to a running web engine to inspect,
start, or cancel the runs already visible in the browser:

```bash
# ENGINE_TOKEN contains the running engine's configured bearer token.
0 chats list --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN
0 automation run --template repository-review --target /engine/repo \
  --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN \
  --chat SESSION_ID
0 runs show RUN_ID --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN
```

When a web engine already owns the selected control database and workspace,
CLI and MCP automation clients discover it through private local metadata and
attach automatically. Use `--chat SESSION_ID` to select an existing browser
mission. A live engine that cannot be authenticated or reached produces an error;
the client does not create a replacement engine. With no registered local engine,
the CLI starts an embedded engine using the same engine services.

Use `--engine production` for a connection in the trusted engine registry
instead of the direct URL and token environment options. The engine supplies its
workspace, scope, model, and execution profile. A selected `--chat` must
already exist; attachment never recreates it or restores approval grants.
Without `--chat`, a run creates an engine mission under its current admission
grants. Targets and artifact paths are interpreted on that engine.

`0 chats show`, `events`, `send`, `continue`, and `cancel` use the same live
mission as the browser. `chats list --saved` and `chats resume SAVED_ID`
inspect retained snapshots and restore a new mission under current grants.
`0 runs resume SCAN_ID --chat SESSION_ID --engine production` resumes a
persisted scan in that live mission. `--branch-from-entry 0` optionally selects a
retained history entry, and time/cost caps narrow the engine's limits. Scan
resume requires the engine's scan resume capability; it does not restart an
automation graph. `0 runs cancel RUN_ID` requests cancellation from the owning engine. An attached
client disconnect leaves that engine running; foreground `automation run` still
requests cancellation on Ctrl-C.

## Steps, evidence, and limits

Templates declare a revision, compatible target types, required inputs, and supported
operations. Template copies retain their pinned catalog identity through saving,
editing, export, and import. Launch checks the pin and target compatibility again.
Focus instructions customize scan steps; they do not enable a separate
dependency, contract, or native verification engine. Typed verification, fix,
research, and deep review steps require their real executor and prerequisites;
an unavailable operation fails preflight rather than becoming a scan.

The portable v1 graph format remains supported. Enabled steps execute sequentially
in topological order, including branches. Connected earlier findings and typed outputs are passed
forward as evidence, with original reports and outputs retained. A sibling branch does
not receive another branch's findings. Earlier evidence cannot grant new access
or override step instructions.

A shared deadline and cost ledger cover the automation and its scan descendants.
Each step's limits can further narrow its remaining allowance. Without explicit
run limits, the runner sums the enabled steps' limits. Repeated scans within
a step are called attempts; they are distinct from the automation run.

Results include original step reports, statuses, findings, and scan/database
references. The combined report collects findings, warnings, and severity counts;
it preserves evidence and verification status and does not deduplicate findings
or perform an additional synthesis pass. Completed partial results remain retained
when later work fails or the run is cancelled.
