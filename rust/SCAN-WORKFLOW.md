# Standalone native HTTP scan

The experimental `0sec-native scan` command runs a complete bounded HTTP
investigation. See [CLI configuration and commands](crates/zero-cli/README.md).
This is the native counterpart to the HTTP portion of the legacy CLI scan
orchestration; repository, browser and managed cloud workflows retain separate
acceptance gates. It does not replace the production CLI.

## Authority and autonomy

A host-owned versioned scan profile freezes provider/model, instructions, tools,
authorized HTTP scope, accounting currency, spending limits and absolute deadline.
The agent chooses hypotheses, requests, permitted experiments, delegation and when
to submit. It cannot expand those grants or declare its findings independently
verified. All conclusions remain `NotEstablished`, with zero verified findings and
`reportable: false`. Claimed severity can affect the documented CI exit status;
it is not verification. An actual empty structured submission is distinguishable
from an interrupted run or prose without a submission.

Before effects, one Store transaction creates the dedicated session, running
controller and actual root actor, immutable intent and original HTTP account.
Root, delegates and experiments use that same model ledger and HTTP account.
Store admission checks enforce frozen templates, source tool calls, reservations,
closure and deadline. Generic inference cannot bypass the scan authority.

Cancellation records closure before acknowledgement and then drains owned work.
Shutdown follows the same order. Unknown provider usage and incomplete HTTP work
retain conservative charges or reservations. Reports expose both model accounting
and aggregate HTTP usage, not usage inferred from a page of observations. Recovery
preserves any cancellation or deadline intent; an uncertain owner loss is never
implicitly resumed. Exact command retries return retained state before requiring
current profiles, and never refill the budget or replay work.

## Retained state and reporting

Store schema17 adds scan projection and command witness indexing. Migration from
schema16 validates the exact preceding schema before changes. Read-only commands
require the exact current schema and neither migrate nor acquire engine ownership.
Earlier campaign portable formats preserve their identity and reject scan state;
a scan is not silently represented as an older campaign export.

Status and list validate metadata and accounting in one read transaction without
copying all response bodies. Full reports use one consistent, private read view of
the source closure, capped at 64 MiB across rows and referenced artifacts. This is
not a portable evidence export or a grant of source authority. Canonical report
publication has a separate 8 MiB limit. An oversized report preserves the compact
outcome and evidence references instead of changing the investigation to Unknown.
Individual bounded evidence routes remain available. Observation pagination returns
the actual source cursor. Later triage annotations do not rewrite the canonical
investigation report.

## Qualification boundary

Local scripted providers and loopback HTTP servers exercise actual dispatch,
root/delegate/experiment accounting, cancellation, deadline, process death,
configuration-free retry, canonical reports and read-only inspection. Store tests
cover schema migration, widened-template rejection, missing or duplicate witnesses,
concurrent read snapshots and preserved legacy export identity. These checks do
not establish live-provider compatibility, detection quality or cloud deployment.

Standalone execution does not activate legacy cloud environment uploads. The
current managed consumer owns final recovered report publication. A native worker
requires matched consumer schema, authorization revision, cost provenance and
partial/final ordering tests before replacing that path. Browser investigation,
repository investigation, broader independent security oracles, production release
selection and full legacy command parity remain in the rewrite backlog.
