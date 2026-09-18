# Host-requested source observation plans

`ReproduceSource { session_id, command_id, request }` accepts
`SourceReproductionRequest { source_operation_id, plan }`. It is an explicit
host command and is never offered to models as a tool. A model-generated JSON
plan is not authorization to execute it. The host chooses the immutable backend,
argv/stdin cases, exact-output expectations, limits and repeat count.

Before any sandbox dispatch, the engine requires a successful source-review
operation in the same session. Its retained bundle and review artifacts must
match the outcome references, artifact-store hashes, validated bundle identity,
hypothesis membership and snapshot digest. The plan must use the original
admitted snapshot root, ID and complete file index. There is no silent re-rooting
or authorization inferred from a model citation. Each execution independently
verifies current source bytes against that pin.

The frozen oracle plan requires attack and legitimate-control cases, distinct
inputs and repeated observations. It rejects an infeasible worst-case aggregate
serialized evidence matrix before execution, including repeated full request
indexes. These constraints improve the specific observation contract; they do
not make arbitrary expectations an independent vulnerability oracle.

## Ownership and evidence

The durable parent owns the session and cancellation token. It retains the plan
before creating any sandbox child. Every child receives a unique execution ID
derived from the parent and case/repeat index. Its exact request is retained
before dispatch. The engine waits for the owned sandbox lifecycle, retains the
raw request/result evidence before settling the child, and only then proceeds.
A child observation with a normal nonzero exit may be valid evidence if the plan
expected that exit; setup/runtime failure remains unavailable evidence.

Evidence is retained per child to stay within artifact limits. The parent stores
an ordered `reproduction.evidence_index` with child/request/evidence identities
and `reproduction.assessment`; it does not repeat raw source indexes and output
buffers in events or its compact outcome. The assessment hashes the complete
ordered observed matrix. Missing observations are not invented or silently
excluded from the required count.

Cancellation stops subsequent cases and waits for active cleanup. Unknown cleanup
stops the matrix as Unknown and retains the executor recovery identity in the
child evidence. A lost owner leaves uncertain children and parent discoverable
for reconciliation. Exact parent retries, including after restart or source
deletion, return their stored receipts without executing any child again.
Changing any bound plan/source-operation input conflicts with the command ID.
There are no invented compute prices or budget reservations for sandbox work;
resource, output, repeat and total matrix limits are explicit execution bounds.

## Result and exit semantics

`Reply::SourceReproduction` includes the durable operation, optional outcome and
retry flag. Outcome fields are the compact assessment, artifact hashes, child
operation IDs, attempted-dispatch flag, controller stop reason and error.

- `ObservedForPlan` and `NotObserved` settle the operation as Succeeded: the
  specified assessment completed. This does not mean a vulnerability was found.
- `Inconclusive` settles as Failed; mismatching legitimate controls, unavailable
  execution and unstable observations cannot become successful negative controls.
- Observed cancellation and uncertain cleanup settle as Cancelled and Unknown.
- Controller cancellation before/between attempts can settle Cancelled while the
  pure oracle remains Inconclusive due to a missing matrix. A supervisor failure
  without a result similarly yields an Unknown parent with the actual incomplete
  assessment. Neither case manufactures a SandboxResult.

`vulnerability_reportable` is always false. Source hypotheses remain Unverified;
this workflow never promotes or rewrites their discovery records.

Loopback source-review and fake sandbox fixtures cover retained matrix recompute,
restart retry after deleting source, complete attack mismatch versus failed
legitimate control, cross-session/provenance/root denial, immutable attachment
substitution, plan/child retention failures before launch, cancellation before
and during execution, and uncertain cleanup that stops remaining cases. These
are lifecycle/orchestration tests, not real vulnerability or isolation results.
