# Frozen offline verification oracle

This is a pure host-side contract and assessor. It launches no commands, calls no
models, changes no source and grants no reportability or execution permission.

`FrozenPlan::parse(bytes)` or `FrozenPlan::new(Plan)` validates and hashes a versioned
host-owned plan. It binds a hypothesis identity, retained source-bundle hash,
complete internally consistent SnapshotPin, immutable Docker image ID or smolvm
archive digest, fixed host limits, at least two repeats, and attack/legitimate
control cases. Case commands/input pairs and IDs must be distinct. Expected exit,
stdout and stderr are exact bytes (base64 in JSON). Oracle version is part of the
hash. Access to the frozen plan is read-only; changing expectations requires a
new digest. The engine must separately establish that the supplied hypothesis,
bundle and snapshot belong to its retained source operation.

Attack cases may freeze a distinct `safe_expected` for later repair. Controls
cannot change their expectation. Baseline `assess` uses only `expected`; it does
not infer or validate a repair. Future repair must bind an independently validated
candidate snapshot to this same frozen oracle and require supplied safe outputs.
A model can propose a plan, but cannot authorize that proposal by returning it.
Host provenance and authorization are the caller's responsibility.

`request(case_id, repeat, execution_id)` constructs the exact sandbox request.
`assess(&frozen, &[Evidence { case_id, repeat, request, result }])` compares the
retained request with that construction, including snapshot root/index/digest,
argv/stdin, limits and backend. Every request/result execution ID must match and
all attempts have distinct execution IDs. Observed image/archive identity must
match the frozen backend. The full case/repeat matrix and stable repeated raw
observations are mandatory. There is no build-command override.

- **ObservedForPlan**: every attack and legitimate control exactly matched its
  frozen exit/stdout/stderr expectations with confirmed cleanup.
- **NotObserved**: complete, stable, valid execution observations, intact controls,
  but at least one attack differed. This is not proof that the source is safe.
- **Inconclusive**: incomplete/duplicate matrix, identity drift, failed controls,
  instability, unavailable setup, timeout, output limit or missing observation.
- **Cancelled**: a correctly bound cancellation was observed, possibly before the
  remaining cases ran. Cancellation before Docker image resolution is accepted
  only with the expected image reference and `NotCreated` cleanup.
- **Unknown**: an observed backend has unconfirmed/unknown cleanup; this takes
  precedence over a negative observation or cancellation.

Known nonzero exits are observable when cleanup is Confirmed and error is absent,
including a backend encoding them as Failed. Failed+zero, missing exit, setup
errors and `NotCreated` do not become successful observations. Explicit OutputLimit
and any stream exceeding the plan cap are inconclusive, even if the prefix matches.
No JSON success/vulnerable/safe field is interpreted: stdout is opaque exact data.
`vulnerability_reportable` is always false. These are command-output observations,
not filesystem-effect proofs, exploit confirmation or a general security verdict.

Evidence comes from the trusted executor journal, not from an untrusted submitted
JSON report. This library cannot authenticate a caller, prove the guest actually
ran, detect fabricated SandboxResult records, or infer the request that produced
an unrelated result. The owning engine must retain the actual request/result pair
and source provenance before calling the assessor. A controller cancellation or
panic with no recorded result remains a separate engine Cancelled/Unknown outcome;
the pure oracle honestly returns Inconclusive for its incomplete evidence.

Plan JSON and decoded expected/stdin totals are capped at 1 MiB, each expected
stream at 64 KiB, cases at 32 and repeats at 2..8. Snapshot index is capped at 4096
entries. Request validation uses the shared sandbox limits (with a stricter 60s
plan deadline). Fixed matrix/request/output budgets are checked before freezing.
Full serialized evidence is bounded at 32 MiB and streamed into its SHA256 hash;
no prefix is used as the evidence identity. Assessment hashes its serialization
with an empty `assessment_digest` field. Parsing rejects unknown plan fields and
unsupported versions; arbitrary raw stream bytes round-trip unchanged.

Tests are oracle fixtures, not OS-isolation qualification. They cover spoofed
success JSON, wrong request/snapshot/image, duplicate and missing cases/IDs,
setup/truncation versus genuine stable negatives, cleanup uncertainty, cancellation,
control failure, unstable repeats, expected nonzero exits, safe-expectation drift,
binary streams and an actual executor-produced snapshot manifest cross-check.
