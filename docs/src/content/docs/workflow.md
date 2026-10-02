---
title: Workflows
description: Create reusable security workflows in the browser, CLI, or MCP.
---

A template is a starter definition. A workflow is a reusable definition of steps.
A run captures one execution and its results. CLI, browser, and MCP adapters use
the shared workflow runner; assessment steps use 0's configured model runtime.
Configure your provider before starting assessments. The external coding agent's
model session does not configure 0's provider.

## In the browser

Run `0 web` and open **Workflows**. Choose a template or describe a custom workflow
in chat. Select a step in **Steps** to edit its instructions, tools, and limits.
**Definition** lets you inspect and copy the saved JSON to keep a version in git
or import it into another workspace.

Set a target and use **Run** for a single execution. Use **Triggers** to configure
hourly, daily, or weekly schedules. An enabled schedule needs a running
browser server and a working engine connection; closing the server stops its scheduler.
Review execution status and results in **Runs**.

## Discover and inspect

```bash
0 workflow list --format json
0 workflow list --templates --format json
0 workflow show --template repository-review
0 workflow show WORKFLOW_ID
```

Discovery does not execute assessments. Saved definitions and run history live in
the control database; `--db-path /absolute/path/control.db` selects that database.

## Execute

Execute a template directly without saving a workflow copy:

```bash
0 workflow run --template repository-review --revision 1 \
  --target /absolute/path/to/repo \
  --workspace /absolute/path/to/repo \
  --time-cap 600000 --cost-cap 5 --format json > run.json
```

Execute a saved workflow with a pinned revision:

```bash
0 workflow run WORKFLOW_ID --revision 3 \
  --target https://target.example.com \
  --scope /absolute/path/to/scope.json --format json > run.json
```

Select one saved workflow ID or `--template`. `--revision` pins either selector. Saved workflows may supply a
default target; a template needs `--target`. `--model` selects a model through
0's configured provider. Time caps are milliseconds and cost caps are USD,
and apply across the workflow. Cost accounting is estimated; in-flight calls may
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
both the host permission and the run request permission; portable workflow JSON
cannot grant either. A saved fix step's apply mode alone does not authorize writes. Application also
requires approval of the exact live candidate owned by that process; a retained
candidate ID from another CLI invocation is insufficient.
Fix candidates and applied patches retain their own verification status; creating
a candidate does not prove that it fixes the finding.

```bash
0 workflow run WORKFLOW_ID --target /absolute/path/to/repo \
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
workflow cancellation. Existing kernel verification keeps its own wall-clock
controls. Run completion and the reproduced, fixed, or hypothesis verdict remain
separate fields in the retained outputs.

## Retained runs and host lifetime

The existing `0 review`, `0 scan`, and `0 audit` shortcuts execute one-step
assessment workflows and retain their run snapshots and results in the same
control database. The `fix`, `verify`, `research`, and `deep-review` command
shortcuts also retain one-operation runs through the shared runner. `audit` is the package assessment shortcut. These shortcuts
preserve their established output and CI exit conventions: for example,
`review` can exit with code 1 for findings while `workflow run` exits with code 0
for a completed execution containing findings. Inspect the retained run status
and evidence to distinguish findings from an execution failure.


```bash
0 runs list --format json
0 runs show RUN_ID --format json
```

Run history does not implicitly resume interrupted work. An embedded CLI or MCP
host runs the same session and workflow services as the web server; closing that
host ends its execution lifetime. Attach to a running web engine to inspect,
start, or cancel the runs already visible in the browser:

```bash
# ENGINE_TOKEN contains the running engine's configured bearer token.
0 sessions list --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN
0 workflow run --template repository-review --target /engine/repo \
  --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN \
  --session SESSION_ID
0 runs show RUN_ID --engine-url http://127.0.0.1:3000 --engine-token-env ENGINE_TOKEN
```

When a web engine already owns the selected control database and workspace,
CLI and MCP workflow clients discover it through private local metadata and
attach automatically. Use `--session SESSION_ID` to select an existing browser
chat. A live engine that cannot be authenticated or reached produces an error;
the client does not create a replacement host. With no registered local engine,
the CLI starts an embedded host using the same engine services.

Use `--backend production` for a connection in the trusted backend registry
instead of the direct URL and token environment options. The engine supplies its
workspace, scope, model, and execution profile. A selected `--session` must
already exist; attachment never recreates it or restores approval grants.
Without `--session`, a run creates an engine session under its current admission
grants. Targets and artifact paths are interpreted on that engine.

`0 sessions show`, `events`, `send`, `continue`, and `cancel` use the same live
session as the browser. `sessions list --saved` and `sessions resume SAVED_ID`
inspect retained snapshots and restore a new session under current grants.
`0 runs resume SCAN_ID --session SESSION_ID --backend production` resumes a
persisted scan in that live session. `--branch-from-entry 0` optionally selects a
retained history entry, and time/cost caps narrow the engine's limits. Scan
resume requires the engine's scan resume capability; it does not restart a
workflow graph. `0 runs cancel RUN_ID` requests cancellation from the owning engine. An attached
client disconnect leaves that engine running; foreground `workflow run` still
requests cancellation on Ctrl-C.

## Steps, evidence, and limits

Templates declare a revision, compatible target types, required inputs, and supported
operations. Template copies retain their pinned catalog identity through saving,
editing, export, and import. Launch checks the pin and target compatibility again.
Focus instructions customize assessment steps; they do not enable a separate
dependency, contract, or native verification engine. Typed verification, fix,
research, and deep review steps require their real executor and prerequisites;
an unavailable operation fails preflight rather than becoming an assessment.

The portable v1 graph format remains supported. Enabled steps execute sequentially
in topological order, including branches. Connected earlier findings and typed outputs are passed
forward as evidence, with original reports and outputs retained. A sibling branch does
not receive another branch's findings. Earlier evidence cannot grant new access
or override step instructions.

A shared deadline and cost ledger cover the workflow and assessment descendants.
Each step's limits can further narrow its remaining allowance. Without explicit
run limits, the runner sums the enabled steps' limits. Repeated assessments within
a step are called attempts; they are distinct from the workflow run.

Results include original step reports, statuses, findings, and scan/database
references. The combined report collects findings, warnings, and severity counts;
it preserves evidence and verification status and does not deduplicate findings
or perform an additional synthesis pass. Completed partial results remain retained
when later work fails or the run is cancelled.
