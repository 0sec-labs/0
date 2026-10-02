# Unified engine contract

The engine owns execution. Browser, CLI, MCP, and remote connections are adapters
that select an owning engine and submit typed requests. They do not independently
construct another workflow runtime, reinterpret remote paths, or silently execute
locally when a selected engine is unavailable.

The shared contract is `packages/shared/src/engine-operations.ts`.
`ENGINE_OPERATION_DEFINITIONS` names workflow discovery, revisioned definitions,
run lifecycle, session lifecycle, decisions, and scan continuation.
`createEngineCapabilityManifest` advertises only the operation ports explicitly
registered by the host. An operation's presence in the contract is not evidence
that a particular engine implements it. `requireEngineOperation` rejects missing
operations before dispatch. The manifest contains no endpoints or credentials.
Transport handshake capabilities still gate routes; operation support adds a more
precise check within those routes.

## Implementation and ownership

The existing core workflow runner owns connected execution, deadlines, shared
provider spend, cancellation signals, and aggregate evidence. The owning service
retains snapshots, results, and links. CLI and web adapters reuse the assessment,
finding, research, and deep-review executors. The unified facade integration binds
workflow and session host ports rather than copying these engines into another
transport. A host advertises a port only after binding its real implementation.

Session continuation, saved-session restoration, and persisted scan continuation
are different operations. The manifest derives session and scan resume flags from
`resume_session` and `resume_scan` registration. It always marks workflow resume
unsupported: inspecting retained results or starting a fresh revision-pinned run
is not checkpoint recovery or automatic replay of interrupted steps. A scan-resume
adapter must retain journal/target/owner bindings and existing storage routing.

Report export is an explicitly supplied list of formats, separate from execution.
No export format is enabled by default. Export reads retained canonical results;
it must not rerun an assessment, invent missing evidence, or expose another
owner's results. `get_run_results` availability does not imply every export format
or every legacy scan result is accessible through the selected engine.

## Verified command coverage

`ENGINE_COMMAND_COVERAGE` records the audited adapters and their boundaries. It is
a coverage catalog, not a tool allowlist or authorization grant.

| Family | Workflow executor/templates | Other surface and boundary |
| --- | --- | --- |
| Source, package, web assessments | `audit`; repository/dependency/API/web/scoped/package/contract/native templates | CLI assessment shortcuts retain one-step runs. A contract/native source review does not claim a specialized native proof engine. |
| Fix | `fix`; `fix-candidate` | `generate_fix` chat tool has its own contract. Application requires the exact live candidate, validation, host/request permission, and approval. |
| Verification | `verify`; `finding-verification` | `verify_finding` is independently gated. CLI kernel verification is not a portable workflow executor. |
| Research | `research`; `security-research` | Managed modes are pipeline, mobile intake, and external Linux boot-matrix import. Managed pipeline targets are authorized local source. Importing boot evidence does not execute boots. |
| Deep source review | `deep-review`; `deep-source-review` | Provider and authorized local workspace prerequisites apply. |
| Offensive specialist engines | No portable step/template | Variant/assumption hunt, protocol conformance, spec drift, safety evaluation, memory fuzzing, npm discovery, kernel weaponization, and CVE adaptation have native chat tools with scope, feature, and prerequisite gates. CLI tools can have different contracts. |
| Other specialist CLI contracts | No portable step/template advertised | Binary, exploit, recency hunt, lens synthesis, XNU fuzzing, disclosure, evaluation, benchmark, and ingestion commands are not made workflow-capable by sharing a model or transport. |
| Maintenance | No workflow/tool grant | Configuration, credentials, plugin/theme management, database maintenance, upgrade, and diagnostics belong to the host control surface. |

## Remaining implementation boundaries

Linux reproducer research explicitly rejects managed execution because its VM/build
runner does not yet provide workflow cancellation and deadlines. Its explicit CLI
entry remains available with its own evidence gates. Adding a portable specialist
step requires a typed input contract, real engine delegate, budget/cancellation
support, retained evidence, and tests; a template prompt alone is insufficient.

The shared capability manifest tests cover registered-port-only advertisement,
resume consistency, rejected unknown/duplicate operations, report opt-in, absence
of credential fields, and coverage of every current template. They do not qualify
all specialist command engines or external provider execution. Engine connections
and isolation qualification are recorded in `docs/design/backend-connections.md`.
