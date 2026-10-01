# Security workflow definitions and triggers

Workflows are reusable security review graphs. The library provides templates,
the graph editor changes individual phases, and Definition edits portable JSON.
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
      { "id": "report", "type": "report", "label": "Summarize findings", "enabled": true }
    ],
    "edges": [
      { "source": "start", "target": "review" },
      { "source": "review", "target": "report" }
    ]
  }
}
```

The graph must be acyclic and connected from exactly one enabled trigger, with
at least one audit phase and at most one terminal report. It supports up to 16
nodes. Only audit nodes accept plans and execution policies. Missing plans use
finite defaults: one sequential review, ten minutes, and a $5 phase budget.
Unknown schema fields and definitions over 64 KiB are rejected.

Top-level `instructions` describe the workflow. Each phase's
`execution.instructions` guides its agent review. Portable export excludes
database identity, revision, timestamps, execution history, schedules, and
approvals. Import creates a new identity. Saved edits use revision checks to
prevent overwriting another editor's changes.

## Phase tools and execution

`execution.allowedAgentTools` contains exact agent tool names. An omitted list
inherits the available tools; an empty list permits no agent tools. The native
runtime filters advertised tools and rejects disallowed tool dispatches.
Subagents inherit restrictions, and nested restrictions can only narrow access.
Execution policies require the native runtime; unsupported runtimes fail closed.

This policy controls agent tools. Deterministic preparation, static scanners,
and dependency checks run separately under their existing pipeline gates. It
does not sandbox commands or restrict every action a permitted shell tool can
perform. Target authorization and mode checks still apply.

Templates are cloned definitions with editable phases and blank targets. Using
one does not install tools or authorize a penetration test. The Graph editor
supports adding and removing phases in linear graphs; Definition can represent
validated branches. Runs retain the reviewed definition revision and phase
results independently of later edits.

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

Current triggers are manual Run, saved schedules, and authenticated local API
requests. There are no public webhooks or event subscriptions. The local API
uses the same revision, approval, target, and runtime checks:

- Definitions: `/api/console/workflow-definitions`
- Manual execution: `/api/console/workflow-definitions/:id/run`
- Execution history: `/api/console/workflow-definitions/:id/executions`
- Schedule bindings: `/api/console/workflow-triggers`
- Agent tool catalogue: `/api/console/workflow-tool-catalog`
