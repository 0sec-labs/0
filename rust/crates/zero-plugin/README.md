# Native plugin admission foundation

`zero-plugin` validates language-neutral immutable plugin bundles and bounded
newline JSON-RPC data. It does not import packages, execute code, contact a
marketplace, spawn a worker, grant operating-system access, or activate a
runtime generation. All state is in memory; the host must persist its policy
and immutable generation pins separately before running anything.

## Manifest and artifact identity

`Manifest::parse` accepts schema version 1 and plugin protocol version 1, with
unknown fields rejected. Versions are exact numeric `major.minor.patch` triples;
prereleases/ranges are intentionally unsupported. Tool declarations require a
nonempty closed capability set. Parameters use the explicit bounded `Schema`
subset (string, signed integer, boolean, array, closed object); unsupported JSON
Schema keywords reject instead of silently weakening validation.

Each artifact declares a lower-case SHA-256 and byte size. `Bundle` supplies all
and only the declared bytes, including the entrypoint artifact. The entrypoint
argv is inert data; its interpretation belongs to a future sandbox runner.
Manifest digests hash typed deterministic JSON serialization, not original JSON
whitespace. Arrays retain their declared order. Manifests are bounded to 1 MiB,
bundles to 8 MiB, and a registry to 128 plugins and 64 MiB of artifact bytes.

`Registry::admit_batch` verifies the entire batch before inserting anything.
Dependencies select an exact ID and version; a registry is an immutable snapshot
with one digest per ID, so rebinding an existing ID is rejected. Admission pins
resolved dependency manifest digests; calls return transitive dependency pins.
Missing dependencies, version mismatches, duplicate identities and cycles fail.
A new implementation/version requires a new registry snapshot and new policy.

## Authority is supplied by the host

Admission starts disabled with no grants. `Registry::authorize(id, digest,
HostPolicy)` is a host-only API: policy is not deserializable from manifests or
RPC. Grants must be a subset of declared capabilities and bind the exact
manifest digest. Enabled/trusted flags never grant capabilities. `trusted` is
provenance metadata, not a permission bypass. The host may grant a subset to
make only those tools callable. Dependencies must independently be enabled and
have their own complete declaration grants before a dependent call is prepared.

`Registry::prepare_call` validates the selected tool, declared input schema,
flags, grants and dependency readiness. It returns an `Invocation` description,
**not an execution permit**. The later broker must enforce engagement scope,
filesystem/network resource restrictions, sandbox backend qualification,
provider budgets, and generation leases. In particular, `process-exec` is not
proof that network access is safe or blocked. This crate cannot verify whether
plugin code honestly declares its effects. No generated flag, tool name or RPC
argument changes policy.

## Framing is data, not dispatch

`Frame::{Request, Result, Error}` uses JSON-RPC 2.0 with unsigned numeric IDs.
The only request method is `tool.invoke`; notifications and host broker calls
are unsupported. `Decoder::feed(bytes, callback)` handles arbitrary byte splits
without collecting an unbounded batch. A line is limited to 1 MiB, arguments and
serialized results to 100,000 bytes. Errors or partial EOF poison the decoder;
there is no silent resynchronization/truncation. Valid earlier frames in a feed
may have reached the callback before a later invalid frame fails.

A transport must separately enforce direction, outstanding ID correlation,
frame counts/rate/deadlines, cancellation and output provenance. Parsed results
are untrusted data. The RPC codec never calls registry authorization or tools.
Protocol version 1 in this manifest is the **native** contract; it is not wire
compatible with TypeScript's `{v, kind}` plugin protocol.

## Existing behavior retained and intentionally deferred

The reference TypeScript modules are `packages/core/src/plugins/manifest.ts`
(closed capabilities and mandatory declarations), `enablement.ts` (installed,
enabled and running are separate; changed capabilities need new approval), and
`protocol.ts` (bounded framing and host-mediated calls). The native architecture
in `docs/design/2026-09-18-native-harness-architecture.md` requires immutable
artifact bindings and versioned subprocess RPC. This crate implements admission
and framing only. Worker lifecycle, broker APIs, durable policy storage, hot
replacement, model calls and empirical evaluation remain separate work.

Validation: `cargo test -p zero-plugin` covers manifest/schema/version failures,
artifact drift, atomic graph admission, missing dependencies/cycles, separate
host grants, argument validation, byte-split framing, ambiguous JSON fields,
bounds, poisoned EOF and authority-bearing inputs remaining inert data.
