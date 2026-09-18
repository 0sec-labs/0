# Native journal

`Store::open` accepts an explicit native database path. It never discovers or
migrates the TypeScript database, changes its journal mode, or marks running
operations recovered. Application identity and schema version are checked before
initialization; unrecognized nonempty SQLite databases are rejected.

All admission, operation, budget and event mutations use immediate SQLite
transactions with a five-second busy timeout. A session pins its generation.
Caller command IDs are unique within a session; canonical object-key ordering
makes retries independent of JSON property order. An exact retry returns the
original operation, including its current state, without producing another event.
A second begin fails even for the same owner: admission is not permission to
repeat an external effect.

Schema v2 adds a SQLite engine epoch. After acquiring the exclusive lifetime
lock, the engine calls `claim_engine_epoch`: recovery of the previous epoch's
running operations and publication of the new owner commit in one transaction.
Ownerless admitted operations become `Failed` with `not_started` evidence; exact
retries return that terminal result without launching work.
The stable sidecar lock inode contains no authoritative owner text. Migration
from v1 recovers all pre-epoch running operations under that exclusive lock,
including those whose old owner text was torn. `Store::open` alone does not
claim an epoch. An explicit `recover_owner` remains available after its caller
establishes that the specified owner is dead or quiescent. Recovered operations
become `Unknown` and cannot begin again; reservations remain outstanding. This store does not provide
distributed leases, external-effect reconciliation or process liveness detection.

Budgets use integer units selected by the caller. Reservations consume available
capacity; settlement releases the reservation and records actual usage. Actual
usage may exceed the limit and is still recorded. New reservations then fail.
Identical reservation/settlement retries are no-ops; conflicting retries fail.
Budget aggregates are bounded by SQLite's signed integer range.

Events are ordered within a session and paged by an exclusive sequence cursor.
Pages are bounded by both row count and 4 MiB of serialized event data. When
the next event does not fit, return the completed page and continue from its
last sequence. A single oversized first event returns an explicit error naming
its sequence; it is never silently skipped. The SQL query checks oversized
payload lengths before materializing them. Session listing is not yet paginated.
No retention/pruning is implemented. Event payloads are generic JSON, not proof
that a model turn or security scan was executed.

Schema v4 adds immutable artifact bytes and named operation attachments. A running
operation's exact owner can retain up to 64 named artifacts, each at most 8 MiB
and at most 32 MiB in total per operation. Bytes, the attachment, and its journal
event commit in one transaction. Events contain only the hash/name/size; source
bytes are not copied into ordinary event streams. An attachment name cannot be
repointed. Exact retries remain inert after settlement, but new post-settlement
attachments are rejected. Reads validate SHA-256 content identity and bound the
SQL blob before materializing it. These are retained evidence bytes, not executed
code or an authorization to label a finding reproduced. Existing v1/v2/v3 stores
migrate without changing operation ownership, results, or session activation pins.

Schema v5 adds durable agent input intent with exact enqueue identities, fixed
run-command correlation, bounded FIFO/dependency resolution and pending-only
cancellation. Operation outcomes remain the source of queue execution status;
there is no independently settled queue worker. Native v4 migration preserves
all previous artifacts, reservations and ownership records. Read-only access
requires the current exact schema and never performs migration. See
[queue lifecycle](../zero-engine/QUEUE.md) for dispatch and recovery semantics.

Schema v6 adds immutable source-hypothesis triage decisions. Native v5 migration
preserves source artifacts, queue entries, reservations and operation ownership.
`open_read_only` accepts only the exact current v15 schema; it never migrates an
older database, claims an epoch, recovers operations, or creates default records.

A record is identified by session, source operation, hypothesis ID and the
hash-checked `source.review` attachment. Hypothesis IDs can legitimately repeat
across separate reviews, so the source operation is part of every lookup.
The store checks succeeded source-operation identity, outcome/attachment equality,
review content integrity and hypothesis membership; the engine additionally
validates the complete provider/source provenance before exposing this API.
Reviews are bounded to 4 MiB and source outcomes to 8 MiB before materialization.
Absent decisions read as `New`, revision zero. `Accepted`, `Suppressed` and
reopening to `New` are host triage dispositions only: neither source hypotheses,
verification status, operation outcomes, nor budget reservations change.

`triage_source_finding` uses an immediate transaction to check the original
command identity, compare `expected_revision`, append a decision, and append its
session event. Every new decision—including the same status with a new note—
increments the revision. Notes are bounded to 4 KiB of UTF-8 bytes; command IDs
are 1–1024 bytes. Triage command IDs form a separate session namespace from
execution and queue commands. Exact retries are checked before the revision
comparison and return the original immutable decision alongside the *current*
record. They never reinstate a superseded status. Conflicting retries and stale
revisions change nothing. Persisted decisions prevent rebinding to a replacement
review digest, even if replacement bytes and outcome are mutually consistent.

Finding lists use `offset` (the number already read) and a 1–32 row limit over
immutable review order. Continue from `offset + returned_count`; an empty page
is exhausted. History uses exclusive `after_revision` and a 1–100 decision
limit. Both stop at a serialized byte budget below 1 MiB, with space reserved for
the response envelope. A single oversized record fails explicitly. Mutation
responses are bounded before commit. There is no lifetime decision cap or silent
history pruning. The combined record/history API uses one SQLite read snapshot,
so active-engine inspection cannot mix a newer status with an older history
snapshot. These read APIs work through `open_read_only` while an engine owns the
database; SQLite rejects writes on that connection.

The native UI uses two read-only projections without a schema migration.
`session_list_page(after, limit)` orders sessions by ascending creation time and
ID; its exact cursor remains stable when timestamps tie. `session_history`
returns top-level `offline_snapshot_agent` turns newest first, using an exclusive
optional `before_sequence` cursor over their `command_admitted` events. Each
entry cross-checks the original admission, current operation/session and stored
payload digest. Current operation status and optional agent status stay separate:
recovered `Unknown` and ownerless `not_started` outcomes do not fabricate replies
or resume effects. Provider configuration is not needed to read either view.

Both APIs use a single SQLite read snapshot, accept limits of 1–100, and keep the
serialized page at or below 512 KiB. History projects only the prompt, final reply,
error and tool-call count plus operation identities/status; it excludes host
instructions, execution profiles, provider replay and source contents. Each
projected text has an explicit `truncated` flag and retains at most 16 KiB at a
UTF-8 boundary; terminal escaping remains the UI's responsibility. Identifiers
are bounded to 4 KiB. SQL size sentinels precede JSON decoding: a retained history
field exceeding 32 MiB fails explicitly, and the page stops before cumulatively
reading more than 64 MiB of admission/payload/outcome data. An oversized first
entry fails without advancing its cursor. Row/byte limits stop on whole entries;
returned continuation cursors never skip omitted entries. These are display
projections only: original journal/artifact bytes remain unchanged.

`continuable` is a conservative UI hint: known completed conversational turns,
or turn-limit outcomes whose checkpoint digest matches the retained attachment,
with no source-submission terminal result, recovery path or error. It is not a
validation receipt. The engine still checks the exact profile, lineage, original
inference evidence and checkpoint contents when a continuation is requested.

`source_reviews(session, before_sequence, limit)` is a metadata-only attachment
catalog, available through the current read-only store without migration. It
returns admission sequence, operation/command IDs, current operation status and
the digest named by a `source.review` attachment. Every operation status can
appear. A candidate is **not** a validated review, finding, or inspection receipt:
existing finding detail APIs still validate source/provider provenance and
artifact integrity. Corrupted artifact contents remain discoverable and are
rejected on inspection; discovery never reads those bytes or the operation's
current request/outcome.

Each page scans at most 128 journal rows newest first **before** filtering by
admission kind or attachment, with indexed session/sequence bounds. Its exclusive
continuation cursor is the last consumed journal row, not necessarily a returned
review. An empty `reviews` array with a non-null cursor is not exhausted. Limits
are 1–32 candidates and 512 KiB of serialized output including JSON escaping.
Admission payloads are capped at 32 MiB each. A two-phase read checks their lengths
and a conservative 64 MiB aggregate budget before fetching and decoding payloads;
IDs are bounded to 4 KiB. Admissions must match the requested session and current
operation/command identity; status and attachment-digest shapes are checked.
Malformed metadata fails explicitly. Byte limits stop before consuming the next
row, and an oversized first admission fails without advancing the cursor. Each
page uses one SQLite read snapshot; refresh from the head to discover attachments
created after an earlier page was read. None of these reads claims engine
ownership, recovers operations, reserves budget, or accesses a provider.


Schema v7 adds durable agent steering inboxes and terminal seals. A message is
scoped to one root or delegated actor operation; it never changes its model,
provider, tools, budget, or execution authority. Intent command IDs are unique
within the session's steering namespace. Exact retries compare the original
operation and prompt before checking whether the actor still accepts messages.

Prompts are limited to 16 KiB UTF-8, with 32 pending and 128 total messages per
actor. A fresh inference admission atomically binds an ordered pending prefix
and its exact text to the immutable `command_admitted` event. `Captured` means
that a request was journaled, not that a provider received or acted on it.
Uncaptured intent becomes `Undelivered` after terminal settlement, epoch recovery,
or an explicit terminal seal; it is never automatically replayed. Sealing and
checking pending intent use the same immediate transaction, so a final-boundary
race either leaves a pending message to service or explicitly rejects admission.

Read pages contain at most 100 messages and 1 MiB serialized output. Event
witnesses are cached within the read transaction and limited to 64 MiB of raw
materialization; a page may stop early at either bound. Continue using the last
returned message sequence until an empty page. Captured labels and inference
replay both validate original enqueue and capture events. SQL size checks precede
witness/prompt decoding; source/provider outcome bodies are not read. Read-only
opening requires exact schema v15 and performs no migration or ownership recovery.


Schema v8 adds informational operator questions and immutable decisions. Creation
atomically admits and starts an owner-bound tool operation, verifies the original
successful model call and offered question tool, and indexes its root and actor.
The request digest binds the actor, original inference identity, call, and packet.
Question requests contain 1–4 questions, optional 2–4 indexed choices, and explicit
custom/multiple-selection flags; validation bounds each text field and the total
serialized packet to 64 KiB. Each actor can create at most 128 question packets.

Answer/dismiss command IDs use a separate session-scoped decision namespace.
The transaction compares the request digest, requires a live owner, inserts one
immutable decision and event, and settles the tool together. Exact retries return
the original decision before owner checks. Answers cover every question exactly
once and may select only offered indices; custom input needs explicit permission.
Answers and dismissals authorize nothing and never change actor configuration.
Cancellation creates a distinct cancelled receipt. Epoch recovery leaves unresolved
questions interrupted; it never resumes a waiter or accepts a late answer.

Question reads use a single SQLite snapshot, cached operation/event witnesses,
SQL byte sentinels before materialization, and a shared 64 MiB witness budget.
Lists accept an optional root filter, 1–100 records, and a 1 MiB serialized page;
continue after the last returned admission sequence until an empty page. A first
oversized witness fails explicitly; later quota exhaustion returns a prefix.
Reads revalidate original admission, original provider call, and immutable decision
receipts, with no provider access, ownership claim, or recovery mutation.


Schema v9 adds per-invocation approval wrappers, immutable decisions and single-use
consumption witnesses. The opt-in host policy selects only existing snapshot or
offline plugin tools; omission preserves automatic execution. Approval grants no
new filesystem, network, role, provider, plugin or resource authority. Gated
Docker profiles require immutable image identities; microVM archives remain pinned.

Each `approval.intent` artifact (at most 8 MiB) binds the original actor/inference,
provider call, exact offered schema, host policy and full resolved effect payload.
Creation verifies the original successful model call and captured authority before
atomically retaining the artifact and owned wrapper. The 8 KiB UTF-8 preview is
explicitly marked when truncated and is never the approved identity. Each actor
can create at most 128 approval wrappers.

Decision command IDs occupy their own session namespace. Exact retries compare
original intent and decision before liveness checks. Approve keeps the wrapper
running: it means permission, not execution. Consume atomically compares the
frozen effect, admits/starts one child and retains a consume witness; it is never
replayed. Denial settles a canonical no-effect receipt. Cancellation expires
pending or approved-unconsumed permission; consumed children remain owned by the
execution lifecycle. Epoch recovery interrupts unconsumed waiters and leaves
uncertain effects Unknown without automatic resumption.

Read records separate permission status, wrapper status and actual effect status.
Readers verify intent bytes/admission, original provider call and authority,
immutable decision/consume witnesses and exact effect-child admission. They share
cached operation, event and artifact reads under a 64 MiB pre-materialization
budget. Pages are 1–100 records and at most 1 MiB serialized; continue after the
last returned wrapper admission sequence. These APIs do not execute, recover,
claim ownership or mutate approval state. This is offline tool-approval support,
not engagement scope or complete legacy autonomy-mode parity.


## Campaign accounting

Schema 13 adds host-created campaigns, atomically bound run sessions, protected
suite exposures and witnessed effect debits. Creation retains the exact private
controller configuration artifact in the same transaction as the campaign. A
case session cannot escape its account by removing a mutable binding projection:
an immutable session witness must agree in both directions.

The first adapter permits snapshot-free web agents, their explicitly granted
joined children, model inference, HTTP and native adaptive experiments. Other
execution, plugin, source, question, approval, queue and steering entry points
reject in bound sessions. Root requests and root/role provider route, wire,
rates and hosted catalog identities are frozen. Each HTTP hop, including a
redirect, must match the issued fixture's exact scheme/host/port and captured
HTTP policy. General non-campaign HTTP scoping is unchanged.

Session and campaign model reservations/settlements commit together. Actual
reported charges may exceed admission estimates and remain visible; uncertain
usage holds both allowances. Reconciliation is unavailable in bound evaluation
sessions. HTTP request count and body bytes are consumed per possible-dispatch
hop; complete responses settle decoded bytes, incomplete responses retain the
ceiling. Experiment and run counts are permanent, including failed/cancelled
or recovered work. Protected suite exposure is global to this Store and cannot
be reset by starting a new campaign. These records do not grant eligibility.

Cancellation closes admission, and the owning controller signals and drains
active actors. Known pre-root failure/cancellation can retire a run without
fabricating an effect. Epoch recovery retires an ownerless prepared run as
Unknown; it never replays it or refunds its count/exposure. Exact retries are
checked before current owner, cancellation and expiry constraints.

Status and metadata-only run pages use one read transaction. They expose no
private task, advisory text or provider configuration. Active-slot accounting
checks immutable root lifecycle witnesses instead of trusting mutable terminal
status, and does not materialize full root outcomes or every run request into
Rust. A 64 MiB aggregate lifecycle read bound fails closed; scalar byte limits
are checked before allocation. Current run authority is validated separately
at effect admission. Monetary, HTTP, experiment and run dimensions remain
separate units; an accounting receipt is not proof of agent quality or a hard
provider invoice cap.


## Shared advisory-search account (schema 16)

A typed search uses one existing campaign account for proposer inference and all
candidate Development evaluations. Proposal admission atomically binds a private
session, immutable native request and attempt slot, starts its owned operation,
and reserves both session and campaign money. Provider settlement uses the same
existing debit journal as evaluation actors; a different candidate or session
cannot obtain a new allowance. Invalid proposals still consume their paid attempt.

Immutable evaluation records bind the original native proposal, captured baseline,
candidate advisory and generation, controller configuration and a contiguous range
of the account's global 128-run schedule. Only the exact Development fixture,
request and provider authority may enter that range. The next proposal waits for
the prior evaluation schedule and all known work; unresolved holds and Unknown
workers stop admissions. A durable stop decision prevents another proposal.

Projection deletion cannot turn a proposal session or search controller into an
ordinary unrestricted session. Metadata is checked against creation, admission,
start, settlement/recovery and binding witnesses. Read-only metadata and candidate
pages are bounded; proposal reassessment preflights a 64 MiB read budget.
Existing fixed-pair campaigns and opaque controller artifacts retain their prior
behavior. Historical portable schema-14 evidence rejects search state rather than
silently omitting it.

Search version2 can atomically seal a host-validated explicit Final selection,
consume one permanent suite exposure and reserve its global schedule range.
Further proposal and Development admissions then fail. Exact selection retry uses
the original record; a missing projection with a retained witness is corruption.
The Engine guards selection with the current Registry binding, using a short
Registry transaction before the Store transaction, without provider work inside.

Portable layout2 (store layout16) captures all search tables, proposal sessions,
evaluation roots, debits and candidate artifacts from one read transaction.
Hydration is private and read-only, validates membership against witnesses, and
requires an identical canonical refreeze. Search packages do not grant authority;
independent Engine reassessment and Registry import are separate steps. Historical
fixed-pair layout1/store layout14 bytes remain stable after schema migration.
