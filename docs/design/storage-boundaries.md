# Local and hosted storage boundaries

> Status: 2026-10-27

Use the database appropriate to its owner and deployment. Do not require a
Postgres installation to run the local CLI, and do not share local SQLite files
between cloud workers.

| Owner | Storage | Responsibility |
| --- | --- | --- |
| Local `0` engine | Existing SQLite database | Findings, structured learning evidence, workflow state |
| Local conversation service | Private transcript files | Faithful resume data and bounded public-text search |
| Local source memory | Private JSONL with coordinated mutations | Source-backed notes and compatibility with existing records |
| Hosted control plane | Postgres owned by `0cloud` | Shared workspace state, admission/queue, delivery and billing |
| Evidence and research artifacts | Files or service-owned artifact storage | Large inputs, binaries, reports and experiments |

The shared interfaces are the consolidation boundary today; these are not all
stored in one physical database. Retain existing data formats until a measured
bottleneck justifies a versioned migration. A memory framework or vector database
is not required for faithful history, source validation, or current local search.

## Concurrency and recovery

Local SQLite access must use a compatible engine and locking protocol. The Node
WASM and compiled Bun branches use different VFS locks; do not open the same file
concurrently through both runtimes. Keep agent execution behind its owning
engine rather than handing a database file to independent remote workers.

Do not enable WAL as a blanket optimization. The current WASM VFS does not
support WAL, and the native branch's SQLite version must be checked separately.
Unsupported WAL files must be checkpointed or converted with a compatible native
SQLite tool after all users have closed them. Ordinary opens must preserve the
header, journal sidecars and locks; corruption repair is an explicit operation.

Source-note writers serialize reload, append and compaction. A crashed writer's
orphan lock requires explicit recovery after verifying that no writer is active.
This is a compatibility safeguard, not a reason to create another database service.

## When to change this decision

Use server-owned Postgres when multiple machines need authoritative concurrent
writes, shared authorization boundaries, managed backup/recovery, or hosted
availability. Local agents running concurrently on one machine alone do not
establish those requirements. If bounded transcript scans become too slow,
measure an SQLite FTS5 index before adding semantic extraction or an external
memory service. Keep every retrieval hit tied to its authoritative record and
source freshness/status checks.

References: [SQLite deployment guidance](https://www.sqlite.org/whentouse.html),
[SQLite WAL constraints](https://www.sqlite.org/wal.html), and
[Postgres concurrency control](https://www.postgresql.org/docs/current/mvcc-intro.html).
