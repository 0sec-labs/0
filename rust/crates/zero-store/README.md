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
