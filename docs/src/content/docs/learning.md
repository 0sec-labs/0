---
title: Learning
description: Local experience, source-grounded knowledge, and evaluated improvements across security workflows.
---

Learning retains experience on your engine and makes improvement history visible.
Open **Learning** in the browser sidebar, or the **Learning** and **Versions**
sections of a saved workflow.

## What is retained

- **Activity:** terminal workflow/step outcomes and conversation lifecycle
  metadata. Completion, cancellation and infrastructure failure do not become
  positive or negative vulnerability labels. Chat capture excludes message text
  and raw tool output.
- **Knowledge:** existing opted-in source-grounded codebase notes, with source
  hashes and evidence references. Eligible native runs continue to use the
  existing memory retrieval rules. Changed, missing or replaced source files
  invalidate retained notes when the source-learning context is refreshed.
- **Improvements:** proposed and evaluated versions, including their evidence,
  evaluation kind and actual deployment state. The existing evolution registry
  remains the authority for evolved artifact activation.

Metadata-only activity does not create boilerplate knowledge or automatically
rewrite workflow instructions. Verifiers retain their independent context.
Source-memory opt-in and `ZERO_DISABLE_HUNT_MEMORY` continue to apply.

## Process local experience

```bash
0 learning status --json
0 learning process --limit 25 --json
```

Both commands use the local control database. `ZERO_DB_PATH` selects an alternate
database. `--project <id>` filters processing and status; use the same project
identifier for related improvements. Selecting a local repository with
`0 learning process --project /absolute/path/to/repo` also imports its existing
current source notes into the control database. Completed authorized local source
workflows do the same, even when scan state is stored in a separate run database.
The browser engine processes pending work
in bounded batches every five seconds. The durable queue resumes after restart;
expired work leases can be reclaimed without duplicating retained knowledge.

The default worker records activity without model calls. A trusted host adapter
can derive evidence-linked diagnoses or evaluate frozen candidates. Request
bodies cannot supply passing evaluation receipts.

## Run evaluated evolution

```bash
0 learning evolve --config ./evolution.json --project /absolute/path/to/repo --json
```

This runs the existing [source evolution](/improvement-plane/) controller and
mirrors its integrity-checked snapshots, proposal references, evaluation receipts
and lifecycle into Learning. Existing source-access consent, budgets, sandbox
requirements and promotion settings apply. It does not independently activate a
different artifact or rerun a failed model request during reconciliation.

These evaluations are labeled **output-fixture**. Passing expected-output tests
does not by itself establish better vulnerability discovery or verified exploit
success. Real security capability requires independent security benchmarks and
appropriate proof requirements. Candidate generation is explicit through this
command; the default background worker does not continuously spend provider
credits proposing changes.

## Workflow versions

Saving a definition creates an immutable revision. Each execution keeps its
original definition snapshot. Restoring an older revision creates a new revision
and rejects stale edits through optimistic concurrency checks.

Existing definitions and available execution snapshots populate initial history;
missing historical revisions are not invented. Schedules retain their reviewed
revision and require review after definition changes. A restored definition does
not authorize new targets, tools or credentials.

## Isolated workspace observations

SmolVM console sessions can retain bounded source references before guest teardown.
The host checks each file hash against the approved workspace and scope; changed,
out-of-scope, symlinked and oversized files are refused. Guest prose and memory
summaries are not imported. These references appear as hypothesis-level Activity,
not verified findings or reusable Knowledge. Full semantic guest-note transfer and
live VM qualification remain separate work.

## Deployment boundary

The control database, queue and knowledge stay on the selected engine. Browser
requests and caches are bound to that backend. Learning introduces no automatic
customer-data export or hosted evaluator. Execution sandbox qualification and
model-provider residency remain separate deployment concerns.

For the wider architecture and remaining work—fresh-task security evaluation,
workflow-specific candidate generation, promotion policy and optional signed
release distribution—see the repository's
[continuous-learning design](https://github.com/0sec-labs/0/blob/main/docs/design/continuous-learning.md).
