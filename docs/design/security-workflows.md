# Security workflow definitions and triggers

Workflows are reusable security review graphs. The library provides templates,
the Steps editor changes individual assessment steps, and Definition edits portable JSON.
Saving or importing creates a draft; it does not execute tools or grant access.

## Portable definition

Definitions use a versioned JSON envelope. The schema lives in
`packages/shared/src/security-workflows.ts`; templates live beside it in
`security-workflow-templates.ts`.

```json
{
  "schemaVersion": 1,
  "workflow": {
    "name": "Dependency review",
    "instructions": "Review dependencies before release.",
    "target": "",
    "nodes": [
      { "id": "start", "type": "trigger", "label": "Start", "enabled": true },
      {
        "id": "review", "type": "audit", "label": "Review dependencies", "enabled": true,
        "plan": {
          "goal": "known-vulnerabilities", "depth": "default", "runCount": 1,
          "executionMode": "sequential", "timeCapMs": 600000, "costCapUsd": 5
        },
        "execution": { "instructions": "Check manifests and lockfiles for vulnerable dependencies." }
      },
      { "id": "report", "type": "report", "label": "Collect results", "enabled": true }
    ],
    "edges": [
      { "source": "start", "target": "review" },
      { "source": "review", "target": "report" }
    ]
  }
}
```

The graph must be acyclic and connected from exactly one enabled trigger, with
at least one assessment step and at most one terminal report. It supports up to 16
nodes. Only audit nodes accept plans and execution policies. Missing plans use
finite defaults: one sequential review, ten minutes, and a $5 step budget.
Unknown schema fields and definitions over 64 KiB are rejected. The v1 serialized
node types remain `trigger`, `audit`, and `report` for compatibility; the UI calls
executable operations steps and repeated assessment attempts attempts.

Top-level `instructions` describe the workflow. Each assessment step's
`execution.instructions` guides its agent review. Portable export excludes
database identity, revision, timestamps, execution history, schedules, and
approvals. Import creates a new identity. Saved edits use revision checks to
prevent overwriting another editor's changes.

Template clones also retain an optional `template: { "id": "repository-review",
"revision": 1 }` pin. This pin survives portable export and import. Before launch,
the selected catalog revision and compatible target types are validated. Existing
v1 workflows without a pin remain valid. Templates declare the standard
assessment executor, its default profile, supported target types, and findings
and artifact outputs; focus prompts do not select specialized engines.

## Step tools and execution

`execution.allowedAgentTools` contains exact agent tool names. An omitted list
inherits the available tools; an empty list permits no agent tools. The native
runtime filters advertised tools and rejects disallowed tool dispatches.
Subagents inherit restrictions, and nested restrictions can only narrow access.
Execution policies require the native runtime; unsupported runtimes fail closed.

This policy controls agent tools. Deterministic preparation, static scanners,
and dependency checks run separately under their existing pipeline gates. It
does not sandbox commands or restrict every action a permitted shell tool can
perform. Target authorization and mode checks still apply.

Templates are cloned definitions with editable steps and blank targets. Using
one does not install tools or authorize a penetration test. The Steps editor
supports adding and removing steps in linear graphs; Definition can represent
validated branches. Runs retain the reviewed definition revision and step
results independently of later edits.

## Shared execution

CLI shortcuts, workflow CLI commands, the browser adapter, and MCP lifecycle
tools use the shared `executeWorkflow` runner in
`packages/core/src/workflow-runner.ts`. The browser retains its session and
permission checks; local CLI/MCP hosts bind their own execution contexts. The
assessment dispatch in `packages/core/src/assessment.ts` returns
structured outcomes without terminal rendering or process exits.

A run captures its workflow revision and resolved target. Enabled steps execute
in stable sequential topological order, including branched v1 graphs. Graph
branches do not imply concurrent scheduling. Earlier connected assessment reports
are supplied to descendant steps, and their findings become review evidence.
Sibling branches do not receive each other's results. Prior evidence never grants
additional authorization or becomes execution instructions.

The runner uses one workflow deadline and shared cost ledger across assessments
and their descendants. If no run-level limits are supplied, the enabled step
limits are summed. Each step's time and cost cap narrows the remaining allowance.
Cost usage is estimated; in-flight calls can exceed a ceiling before their usage
is recorded and subsequent work stops. Deadline or cost exhaustion fails the run;
explicit cancellation produces cancelled status. Findings, including high
severity findings, do not turn successful execution into failure.

The collected result contains original step reports, findings, step statuses,
and retained scan/database references. A combined report aggregates findings,
warnings, and counts while preserving each finding's evidence and verification
status. It does not perform additional report synthesis or deduplicate repeated
findings. Results already produced remain available after failure or cancellation.
The browser retains results in its control database separately from its bounded
in-memory report view.

## Schedules and triggers

The Triggers tab can save a paused schedule or review and enable it. Scheduling
is a separate deployment binding to a saved workflow revision and owning
conversation. It is persisted in the local database rather than exported in
portable workflow JSON.

Cadences are fixed elapsed UTC intervals: every hour, every 24 hours, or every
7 days. The timezone is display metadata; these are not local wall-clock cron
rules and do not adjust for daylight saving time. The local engine must remain
running. Missed occurrences are skipped instead of replayed in a burst. Atomic
claims prevent duplicate launches across engines and overlapping occurrences.

Each enabled schedule records the reviewed model, provider, and connection
identity. Every occurrence revalidates these and existing target permissions
without opening an approval prompt. Definition or connection changes require
review. Reopening a saved conversation does not restore old permission grants.
Pausing prevents future launches; an already launched run retains its own stop
control.

Current entry points are manual Run, saved schedules, the workflow CLI, MCP
lifecycle tools, and authenticated local API requests. There are no public webhooks or event subscriptions. The local API
uses the same revision, approval, target, and runtime checks:

- Definitions: `/api/console/workflow-definitions`
- Manual execution: `/api/console/workflow-definitions/:id/run`
- Execution history: `/api/console/workflow-definitions/:id/executions`
- Execution results: `/api/console/workflow-executions/:id/results`
- Schedule bindings: `/api/console/workflow-triggers`
- Agent tool catalogue: `/api/console/workflow-tool-catalog`
