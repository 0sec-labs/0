# Unified workflow runtime

Status: shared assessment/workflow runtime and CLI/browser/MCP adapters implemented.
The broader executor/schema roadmap below remains a design proposal where noted.

## Implemented rollout

- Core `executeAssessment` returns canonical and target-specific reports;
  `executeAssessmentRun` routes standalone assessments through the workflow runner.
  CLI `runUnified` retains terminal formatting and exit policy. Standalone
  `review`, `scan`, and package `audit` shortcuts retain their workflow snapshots
  and results in the same control database; embedded assessments do not create
  duplicate standalone runs.
- Core `executeWorkflow` owns sequential graph execution, connected evidence
  handoff, shared spend, workflow/step deadlines, cancellation, and combined results.
  `WorkflowService` adds owned lifecycle, idempotency, bounded events, and persistence
  callbacks for CLI/MCP hosts. The browser retains its session gateway/lifecycle
  adapter and uses the same core runner.
- CLI `workflow list/show/run` and `runs list/show/cancel` are implemented. MCP
  `--workflows` exposes the discovery, authoring, launch, results, and cancel tools
  described below. Atomic live tools retain their separate execution path.
- Template revisions, input compatibility, and portable provenance are implemented.
  The UI uses Workflows, Steps, Attempts, Runs, and Connect an external agent.
  Legacy `audit` node values, routes, and CLI shortcut remain compatible.
- The runner supports typed `audit`, `verify`, `fix`, `research`, and `deep-review`
  executor registration, bounded JSON inputs, connected prior outputs, and retained
  outputs grouped by step. Missing executors fail preflight; operation labels never
  fall back to ordinary assessment. Executor verdicts remain distinct from execution
  status.
- CLI `--inputs` reads a regular JSON file with a 256 KiB read bound and validates
  its values with the shared 32 KiB/20-level/10,000-item contract. `--allow-apply`
  supplies explicit host and request permission; portable definitions cannot grant it.
- Run snapshots and combined evidence persist in the control store. If a result
  exceeds retention limits, execution completion and result availability remain
  distinct; reopening does not invent a clean report.

A new versioned node schema, conditional or parallel graph scheduling, and a daemon
that survives stdio disconnect are not implemented by this rollout. Typed step
registration preserves the existing specialized executor contracts and prerequisites;
only adapters with the real executor registered may launch those operations.
Browser chat can author and queue workflow launches. The gateway waits for the
turn to finish, then obtains launch and target approval at its idle boundary.
Queued request IDs resolve to run IDs; ownership and session configuration changes
cancel or reject stale requests. Browser Run, CLI, schedules, and MCP use the shared
runner. The `fix`, `verify`, `research`, and `deep-review` command shortcuts retain
one-operation runs while preserving their established engine results and exit codes.

Managed live Linux boot research is rejected because the VM/build engine lacks
workflow cancellation support. Passive boot-matrix import remains available.
The legacy kernel verifier retains its own wall-clock control; its shared run
history does not add cancellation or runtime injection to that engine.

## Decision

Use one workflow execution service from CLI, browser, TUI, schedules, and MCP.
An assessment step uses the existing unified assessment dispatch. A workflow
may contain one step or several steps. Templates are versioned starting
definitions, not another execution engine.

Do not make an HTTP request, a verifier, or a patch operation run a full
assessment just to satisfy the name `runUnified`. Share execution ownership,
authorization, cancellation, budgets, events, and retained results; preserve
each executor's input and evidence contract.

## Baseline inspected before this rollout

- `packages/cli/src/commands/run.ts`: `runUnified` dispatches URL/web targets
  to `agenticScan` and other supported targets to `runPipeline`. It also owns
  CLI UI, formatting, exit codes, optional PR emission, and issue export.
  It returns `Promise<void>` and supplies reports/outcomes through callbacks.
  This is an assessment adapter, not a general workflow interpreter.
- `packages/cli/src/web/workflows.ts`: `WebWorkflowService` owns graph
  execution, assessment jobs, and source-fix jobs. Saved graphs run audit
  nodes sequentially in topological order; each audit calls `runUnified`.
  Graph edges order execution but do not explicitly bind output artifacts to
  subsequent inputs. A report node records result links through an event;
  it does not build a combined finding report.
- `packages/shared/src/security-workflows.ts`: the executable graph schema
  permits trigger/audit/report nodes and one target string. Plans bound each
  audit. Workflow-level `instructions` are descriptive notes; phase execution
  instructions reach the agents through the execution policy.
- `packages/shared/src/security-workflow-templates.ts`: eight templates
  contain two or three audit phases. Labels and prompts specialize the
  assessment, but all use the same assessment path. Category does not enforce
  target compatibility, and templates do not select specialized source
  profiles or deterministic dependency-only executors.
- The browser sums phase budgets for display and uses the summed time limit
  as an overall timer. It does not pass a shared workflow cost ledger across
  phases. Each phase has its own cost ceiling.
- `packages/cli/src/commands/mcp-server.ts`: a stdio tool adapter directly
  wraps `ToolExecutor`. It has a fixed live-target allowlist and requires
  target/scan ID at startup. There are no template or workflow execution tools.
- `packages/core/src/console/turn-engine.ts`: chat can list/read and save
  workflow drafts with `console_list_workflows`/`console_save_workflow`.
  That authoring interface does not provide workflow lifecycle operations.
- `packages/dashboard/src/console/agent-onboarding.tsx`: a fixed copied
  setup prompt. Its `sessionId` prop is unused; it does not attach the external
  client to a browser run.
- `packages/shared/src/workflow.ts`: a separate YAML specialist FSM schema,
  exported from shared. No production consumer of this schema was found by
  searching this repository. Do not present it as the executable graph format.
- Browser jobs are also called workflows, while finding workflow components
  describe triage status. These should have distinct product names.

## Vocabulary

| Term | Meaning |
|---|---|
| Template | Versioned starter definition with declared compatible inputs |
| Workflow | Reusable definition of steps, input bindings, and limits |
| Step | One typed operation with a defined input/output contract |
| Run | One execution of an immutable workflow snapshot and bound inputs |
| Attempt | One repetition of an assessment step, currently `ScanPlan.runCount` |
| Tool | An individual capability called by an agent or a typed tool step |
| Trigger | A way to start a run: manual, CLI, MCP, API, or schedule |
| Finding triage | Human review/status tracking, separate from execution |

Use “Steps” in the editor and “Runs” for execution history. Rename descriptive
workflow `instructions` to `description` in a versioned schema. Keep runnable
instructions on the step. Avoid using “audit” as the generic node type:
package audit is one assessment operation, not every operation.

Preserve `0 review`, `0 scan`, and `0 audit` as useful command shortcuts.
They compile a one-step workflow request and use the same service. Avoid a
breaking command rename while replacing the internals.

## Execution architecture

```text
CLI / browser / TUI / MCP / scheduler
                 |
          WorkflowService
                 |
        run snapshot + input bindings
                 |
          WorkflowRunner
                 |
        typed step executor registry
          /          |           \
  assessment     verification    fix/report/tool
      |
  unified assessment dispatch
      |
  agenticScan / runPipeline
```

Extract transport-independent assessment execution from CLI `runUnified`
into core. Keep a compatibility wrapper for formatting, terminal UI, and CLI
exit policy. Extract graph orchestration from `WebWorkflowService` into the
shared service/runner; retain browser session and HTTP adapters outside it.
The name of the extracted assessment function can remain `runUnified` during
migration. The important boundary is that core execution returns a structured
result and never prints, opens a browser, or exits the process.

All executable operations use that service. Atomic tools call the same tool
executor used by assessment agents; they do not start an assessment. When a
user wants a standalone managed operation, represent it as a one-step run.
Reading definitions, configuring connections, and ordinary chat are not runs.

Start with typed assessment and result-collection steps. Add independent
verification, fix proposal, regression verification, patch application, and
report synthesis only with real executor contracts. Integrate specialized
research backends incrementally; do not silently map deep review, binary
analysis, or kernel verification to an ordinary source assessment.

Each run captures the definition/template revision, resolved target, model
connection identity, scope references, and limits. Execution context belongs
to the caller/owner rather than requiring a fabricated browser conversation.
Secrets remain in runtime credential bindings, not portable workflow JSON.
Steps get explicit artifact references as inputs. Prior output is evidence
data, not instructions or new authorization.

A workflow-wide deadline and cost ledger bound all steps and descendants.
Step limits can narrow the remaining allowance. Track execution status
separately from findings: a successfully executed review with high findings
is completed; the CLI may still choose exit code 1 for CI policy.

Initially support sequential steps honestly. Do not advertise parallel
branches or conditional routing until their scheduling, failure propagation,
budget sharing, and cancellation semantics are implemented. Preserve imported
v1 graphs by executing their existing sequential topological semantics.

## Templates and individual operations

Templates should declare accepted target types and required artifacts,
executor/profile choices, default limits, steps, and expected outputs.
Run inputs supply the actual target; a saved workflow may have default inputs.
Template selection must reject incompatible targets before launching work.

Keep recognizable task names: Repository security review, Dependency review,
API authorization review, Web configuration review, Scoped penetration test,
Package behavior investigation, Smart contract review, Native code review.
Do not treat category labels or prompts as proof of a specialized executor.

For the first release, preserve the current templates as clearly described
assessment sequences. Convert named phases to narrower operations only when
those operations exist. For example, a dependency-only step needs an actual
dependency executor; relabeling a full assessment would preserve the problem.
Use one assessment with multiple focus instructions when separate full runs
do not provide useful independence or artifact handoff.

Examples:

- A simple repository review is one assessment step and collected results.
- A staged repository workflow can pass dependency evidence into a source
  assessment, then collect its findings. This needs explicit input bindings.
- A finding verification workflow takes an existing finding/artifact, invokes
  its supported verifier, and preserves the verifier's evidence status.
- A fix workflow explicitly separates proposal, regression verification,
  application, and publication with their existing action permissions.

## MCP interface

Expose workflow capabilities alongside existing atomic tools:

| Proposed tool | Contract |
|---|---|
| `list_templates` | Template IDs, revisions, input requirements, supported executors |
| `get_template` | Complete selected template |
| `list_workflows` / `get_workflow` | Saved definitions with revision identity |
| `save_workflow` | Validate and save a draft with revision checks |
| `start_run` | Resolve template or workflow revision and inputs; return run ID |
| `get_run` | Status, step outcomes, usage, and events after a cursor |
| `get_run_results` | Paginated findings and artifact references, preserving evidence provenance |
| `cancel_run` | Cancel a run owned by the caller's execution context |

`start_run` accepts one selector: a pinned template or saved workflow revision.
It does not require saving a template clone just to execute it. Validate target
compatibility, runtime availability, scope, budgets, and executor prerequisites
before launching. A long run returns its ID promptly; polling does not start
another run. Support an owner-scoped idempotency key for retried launch calls.

The external agent uses its model to choose workflows and interpret results.
An assessment inside 0 uses 0's explicitly configured provider connection.
Atomic MCP tools can be used without creating an internal assessment model
session. Show the selected connection and limits before execution.

Do not reuse today's mandatory URL/scan-ID startup contract for all workflows:
repository, package, and finding workflows have different inputs. Keep existing
live-tool startup behavior compatible; introduce an explicit workflow tool
group and execution context with allowed targets/local roots and provider
binding. Adding a workflow tool group must not silently broaden existing
`--tools` selections or make arbitrary local paths accessible.

For an initial stdio host, runs live while that host lives. Graceful disconnect
cancels owned active runs; crashes leave interrupted history and no implicit
replay of effects. Durable execution beyond a client's lifetime requires a
separately running local engine, not a promise hidden in the MCP adapter.

Browser and MCP runs share the schema and runtime. Cross-client visibility or
control additionally requires the same local engine/store and explicit owner
access; copying an onboarding prompt does not attach a browser conversation.
Rename that UI entry to “Connect an external agent” and generate instructions
for the actual capabilities selected, including workflow execution.

## Implementation order

1. Extract core assessment execution and structured outcomes; preserve current
   CLI behavior with the `runUnified` wrapper.
2. Extract the workflow runner and lifecycle service from the browser. Preserve
   definition revisions, history, target checks, cancellation, and schedules.
   Introduce owner context, run-level ledger, and explicit result collection.
3. Route browser/TUI and CLI shortcuts through it. Add `0 workflow list`,
   `show`, and `run` with template selection; use `0 runs show/cancel` for run
   lifecycle. All these names are proposed, not existing commands.
4. Add MCP template discovery and start/status/results/cancel against the same
   service. Reuse lifecycle tools in browser chat rather than a separate
   `console_*` implementation.
5. Version the definition schema and migrate UI vocabulary. Move launch triggers
   out of executable step lists; migrate legacy trigger/report nodes explicitly.
   Rename or retire the separate unused FSM schema after checking external use.
6. Add typed artifact handoff and specialized executors. Revise each template
   against the capabilities actually shipped. Add graph concurrency later.

Validate with the same fixture definition launched through CLI, browser, and
MCP: identical resolved steps, restrictions, evidence shapes, and retained
results. Cover template compatibility, revision mismatch, idempotent launch,
shared budget exhaustion, cancellation/disconnect, and successful runs that
contain findings. Keep existing verifier and fix tests for their distinct
contracts. The existing MCP/browser workflow suites passed 53 tests during
the initial inspection; that validates current wiring, not this proposal.
