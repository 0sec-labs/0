# Explicit offline evolution provenance

Issue #38 extends the existing receipts and campaign comparison identity. It does
not add a metadata service, provider lookup, ordinary-scan model call, or a second
observation queue.

## Identity inventory and policy

| Existing evidence | Extension | Comparison rule |
| --- | --- | --- |
| Content-addressed baseline/candidate snapshots | Source bytes remain distinct from evaluator implementation | A changed/deleted selected source invalidates recovered development feedback |
| Corpus digests excluding case labels | Explicit content-addition/retirement audit helper | Renaming cases preserves identity; changed contents are incomparable |
| Evaluator implementation and policy digest | Actual bounded sandbox/controller module bytes with invalidating cache | Changed tool/evaluator bytes block reuse/promotion and require restart after an in-process observation |
| Requested model and observed generator provider/name | Generator revision is explicitly pinned, floating, or unavailable | A requested alias never becomes immutable version evidence |
| Declared model-worker charge ceiling | Separate actual host-observed worker revision and decoding digest | Missing/floating/unavailable worker versions block dispatch and promotion |
| Approved observation queue and stamped fixture contents | Optional case→approval→fixture lineage in the evaluation receipt | Pending/rejected observations, altered approvals, and changed/deleted fixtures fail closed |

`EvolutionDependencies.workerModelIdentity()` is the trusted adapter observation
before dispatch. A pinned observation supplies `modelVersionStatus: "pinned"`,
`modelRevision`, and `decodingDigest` (SHA-256 of the actual decoding contract).
`provider` and `model` must match the operator's worker contract. The host's
`EvolutionExecution.workerModelUsage` must repeat that observation with the
observed charge and immutable billing receipt digest. Candidate stdout is never
used for these fields. A billed provider/version/decoding change settles known
charges before blocking the campaign. A pinned assertion missing revision or
decoding evidence is recorded as unavailable, not guessed from a model alias.

The networkless bundled workers are deterministic and identify their actual
baseline/candidate bytes through immutable snapshots. Their evaluator
comparability does not require pretending that the **proposal** provider exposes
an immutable version. Generator aliases remain explicitly unavailable/floating
in the receipt. Model-backed workers require pinned version and decoding
observations from an adapter; this change neither creates a provider adapter nor
grants network access.

Source/package builds attest the bounded authority module files. The esbuild CLI
attests the bounded packaged code chunks and entry loader when source sidecars
are absent (at most 512 files and 64 MiB). Changed bytes after an observation
require a controller restart; new disk bytes cannot impersonate already-loaded
code. A distribution that cannot expose its loaded implementation bytes fails
closed rather than substituting a requested version string.

Historical receipts stay readable. Missing worker identity in an old comparison
cannot certify compatibility. Existing ledger costs/exposure must not be deleted
to work around an incompatible evaluator or unknown revision. Requalification
requires an operator-reviewed comparison context and the authoritative holdout
policy, not renaming an old dataset.

## Curated evidence lineage

`EvolutionCase.curation` optionally records `observationId`, `approvalDigest`, and
`fixtureDigest`; `EvolutionConfig.observationStorePath` locates the existing
operator observation queue. `evolutionObservationApprovalIdentity()` derives the
approval digest from the observation, source-revision digest, and approved fixture
shape, excluding operational claim/processing timestamps.

At the explicit evaluation boundary the controller checks consent and approved or
processed status and reuses `prepareValidationCorpus()` to verify immutable
fixture stamps, clean-control provenance, symlink/overlap restrictions, and changed
or missing source. It validates at most 64 distinct observations per contract. Private observation
queues are rejected if they overlap model-readable selected source paths, including
physical aliases and paths that have not been created yet. Source revision references
must themselves be immutable content digests.
The receipt contains only content digests and observation references. Expected
outputs, private case names, source, credentials, and queue notes do not enter the
lineage record or model-visible development feedback. Existing manually curated
corpora remain supported; observations are never automatically converted to
expected answers.

`auditEvolutionCorpusRotation()` reports retained/added/retired content digests
for operator audit. It never retires a fixture because it is old or difficult.
Versioned receipts preserve the historical comparison even when fixtures rotate.
Model-worker feedback without a fresh trusted observation is withheld rather
than treated as authoritative from a previous provider alias.

## Validation and limits

Deterministic fixtures exercise pinned/floating/unavailable observations, unchanged
aliases with changed versions/decoding, stale selected source, independent fixture
approval, altered approvals, fixture drift, renamed cases, sealed-data isolation,
legacy receipts, reservation settlement, and canary/promotion gates.

`provenance-overhead.test.ts` optionally writes an offline microbenchmark using
`ZERO_PROVENANCE_METRICS`. The committed artifact records this machine's measured
identity-observation p50/p95, identity size, source-file count, and zero model or
worker dispatches. It is a bounded fixture measurement, not ordinary-scan latency,
provider qualification, or evidence of stochastic quality improvement. Ordinary
scan code does not invoke these observation helpers; they run only in explicit
evolution generation, evaluation, feedback recovery, and promotion paths.

Paid pinned-provider qualification and independently curated study data remain
part of #120. No paid calls were made for this PR. This PR does not claim a
statistical guarantee against adaptive holdout reuse; #40 owns that policy.
