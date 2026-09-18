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
