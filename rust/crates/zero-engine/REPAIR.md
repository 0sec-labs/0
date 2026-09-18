# Frozen-plan candidate validation

`ValidateSourceRepair` and `0sec-native source-repair` implement a narrow part of
legacy `fix` / `secure`: one explicitly allowed existing UTF-8 source file in a
verified private snapshot, followed by two observed validation matrices. They do
not implement the complete legacy workflow or apply a patch to the original tree.

The request names a succeeded reproduction operation in the same session. The
engine reloads and hashes its retained plan, source bundle, review, request and
observation artifacts, checks operation correlation, and independently reassesses
the complete baseline matrix. Every attack observation must have a safe expected
output frozen before baseline execution. The target/preimage must match a cited
source file; protected paths remain unavailable.

Only the candidate snapshot and the attack case's expected output change in the
derived plan. Commands, controls, backend, limits and repeats stay fixed. After
validation, the engine deletes the private candidate, reconstructs it from the
original pinned snapshot and retained replacement, compares the content/policy
receipt, and runs the matrix again. Both complete matrices must pass. Success is
`validated_candidate_for_plan`, never a general vulnerability or repair-quality
claim. `vulnerability_reportable` remains false.

Replacement bytes live in bounded artifacts. Ordinary admission records contain
a request digest, not replacement contents. Exact command retries return stored
results without rereading, editing or executing, including after restart and
removal of the original source. Provider charges belong to discovery; validation
does not invent monetary compute charges.

Cancellation waits for owned work and cleanup. Uncertain sandbox cleanup stops
further cases and retains the candidate path for recovery. Retention failure
before execution cleans up the candidate; uncertain cleanup is never success.
Host filesystem calls cannot guarantee a hard interruption deadline. SIGKILL
while a private copy is being materialized can leave a temporary directory before
its prepared event is persisted; full orphan discovery remains a qualification
gap. No automatic replay or inferred cleanup claim closes that gap.

Acceptance tests in `tests/source.rs` use an injected local Docker CLI to check
two-copy validation, control failure, target/preimage restrictions, corrupted
baseline evidence, retention failure, cancellation, recovery retention and exact
restart retry. These are lifecycle/semantic tests, not real-backend qualification.

The CLI real-Docker acceptance test also passed on this Linux host with a preloaded
Node image (12 executions: four baseline, four candidate, four reconstructed).
It checks exact observations, controls, unchanged original bytes and restart
retry without source/provider access. This qualifies that fixture and backend,
not real vulnerability detection or other platforms.
