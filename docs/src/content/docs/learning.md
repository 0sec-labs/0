---
title: Learning
description: Local experience, source-grounded knowledge, and evaluated improvements across security workflows.
---

Learning saves useful lessons so later investigations can start with what you
already know. Open **Learning** in the browser sidebar.

## Lessons and suggestions

- **Lessons:** source-linked notes about a codebase: useful files to inspect,
  trust boundaries, and investigation or testing approaches. Authorized local
  CLI and web chats can save these with `remember_codebase`. Later chats on the
  same codebase recall matching lessons and recheck the cited file hashes before
  each model request. Changed files and disabled lessons are excluded.
- **Suggestions:** changes to workflow instructions that you can review before
  applying. Run evidence is shown with each suggestion.

A finished chat is history, not a lesson. Completion events remain internal
records; they do not populate the Lessons view or label vulnerabilities.
Lessons are hints to check against the source, not verified findings or model
training. Verifiers do not receive them. `ZERO_DISABLE_HUNT_MEMORY=1` disables
source memory; the engine API also accepts `codebaseLearning: false`.

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

## Automatic workflow suggestions

If the same step fails in three separate runs after its instructions change,
Learning can suggest the instructions from an earlier version that finished
successfully. It reads the last 200 runs and events; chat errors, cancellations
and ordinary completions do not create suggestions.

Suggestions keep the same target, step graph, tools, budgets, inputs and fix
settings. They never run or apply themselves. Review the earlier instructions,
then apply the suggestion to save a new workflow version. If someone edits the
workflow or dismisses the suggestion first, applying it fails rather than
replacing their changes. Existing schedules still need their own revision review.
A successful earlier run is operational evidence, not proof of better security.

## Isolated workspace observations

SmolVM chats can save bounded source-linked lessons on their host engine before
teardown. A fresh VM requests current lessons for its approved directory before
model calls. Both sides check file hashes; lessons stay out of saved chat history
and do not grant tools or permissions. Disabled lessons and changed files are
excluded. Host memory stores, database handles and provider credentials are not
serialized into the guest.

Standard mode needs host-approved local scope. YOLO mode can use an explicitly
granted workbench workspace and its subdirectories; an implicit current directory
is not a host scope grant. Learning opt-out and verifier isolation still apply.

The [runtime qualification report](https://github.com/0sec-labs/0/blob/main/docs/design/smolvm-qualification-20261002.md)
records the tested distribution and runtime limits. Complete toolbox qualification
is separate: the selected image still lacks SSH and needs a rebuilt archive.

## Deployment boundary

The control database, queue and knowledge stay on the selected engine. Browser
requests and caches are bound to that backend. Learning introduces no automatic
customer-data export or hosted evaluator. Execution sandbox qualification and
model-provider residency remain separate deployment concerns.

For the wider architecture and remaining work—fresh-task security evaluation,
broader candidate generation, promotion policy and optional signed
release distribution—see the repository's
[continuous-learning design](https://github.com/0sec-labs/0/blob/main/docs/design/continuous-learning.md).
