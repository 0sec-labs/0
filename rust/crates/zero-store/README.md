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
`open_read_only` accepts only the exact current v6 schema; it never migrates an
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
