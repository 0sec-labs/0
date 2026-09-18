# Frozen web observation plans

This pure library binds a host-provided plan to one retained web review and
hypothesis, the original HTTP profile and shared account, and inherited approval
policy. It neither sends requests nor accepts a model's success verdict.

`FrozenPlan::new` validates and normalizes 2–8 named attack/control cases with
2–3 repeats. At least one attack and one legitimate control are required; their
normalized requests must differ. Execution order is repeat-major, then case
order. Every expectation is an exact HTTP status and SHA-256 of the complete
retained **redacted** response body. The fixed oracle version and explicit
`same_static_identity_existing_target` state mode are part of the identity.
This does not reset the remote target or establish an independent login session.

The canonical intent also binds the session, original root account, and inherited
tool approval policy. `approval_required()` reports whether `http_request` is
gated. The engine requires the operator's explicit approval of the entire intent
before admitting such a plan. Host-generated attribution and default headers are
regenerated from the captured policy; canonical case arguments retain only caller
headers, avoiding accidental reinterpretation of host headers as caller authority.

`assess` requires uniquely identified attempts in matrix order with matching
request digests. Complete stable attack matches with successful controls yield
`ObservedForPlan`; stable attack mismatches yield `NotObserved`. Failed controls,
unstable repetitions, missing or malformed observations yield `Inconclusive`.
Cancellation and uncertain effects remain explicit. Every assessment sets
`vulnerability_reportable: false`. Its caller must authenticate attempts against
the execution journal; serialized caller assertions alone are not evidence.

Bounds: plans 4 MiB, canonical intents 8 MiB, at most 24 attempts and 256 KiB of
attempt metadata. Engine reports reconstruct actual HTTP receipts and body hashes,
with at most 24 × 16 MiB of body reads, one body at a time; original review citation
validation has its separate aggregate bound. No cookie capture, identity switching,
remote reset, browser execution, callback service, or raw-secret oracle is implied.

## Inline agent experiments

`FrozenExperiment` uses the same sealed observation-matrix scorer and request
normalization as `FrozenPlan`, with an explicit actual actor/inference/tool-call
origin. It does not manufacture a completed review or a host verification plan.
The host's `WebExperimentPolicy` bounds case/repeat counts and the separate Store
account-wide admission quota. The model chooses its provisional hypothesis,
purpose, requests and expected responses. Those expected responses are predictions,
not host-established security truth. Matching them never makes a vulnerability or
strategy improvement reportable.

The frozen intent binds the captured HTTP context/account, experiment policy,
inherited approval policy, versioned matrix and immutable hypothesis revision.
Both `http_request` and `run_web_experiment` approval gates require permission for
the exact whole matrix. The controller additionally authenticates prior-revision
lineage and actual original offered tool/arguments; the pure library does not
pretend a supplied operation ID proves those facts. Parent payloads bind source
operation hashes, and HTTP children use `frozen_agent_experiment` explicitly.

Parent/child payloads must fit the 4 MiB atomic owned-admission limit, including
the optional approval link. The fresh internal executor inherits cancellation
and the original account rather than creating a new root. Read-only reassessment
uses actual retained HTTP outcomes, exact matrix positions and immutable recovery
witnesses; owner loss yields Unknown with unavailable response fields where no
response receipt exists. No recovery path runs a request again.
