# Native web investigation and independent observation plans

The experimental `0sec-native` workflow connects scoped HTTP observations,
terminal model hypotheses, explicit host plans, fresh target requests, operator
triage and retained reports. It does not replace the complete legacy web scanner.
The production TypeScript CLI and cloud release remain unchanged.

## Ownership and execution

`zero-engine` owns sessions and actor lifetimes. A web actor may omit `execution`
and use a named `http_profile`; this creates a `scoped_web_agent` and offers no
snapshot execution tool. Requests with an execution profile retain the historical
`offline_snapshot_agent` identity. Snapshot source modes still require execution.

Set `web_submission_max_hypotheses` to 1–32 to require the terminal
`submit_web_hypotheses` tool. It is mutually exclusive with terminal source
submission. Only roots may submit; joined HTTP roles return observations to their
parent. Empty submission is valid and says nothing about target security. A
terminal web review cannot become a continuation checkpoint.

Every hypothesis remains `Unverified`. Claims reference exact retained HTTP
operation IDs and manifest digests. Status, indexed header, and bounded body
citations refer to complete, validated observations; body coordinates are bytes
of the redacted, decoded response. Evidence from another same-session root does
not become eligible merely because the model knows its operation ID. Joined
children and explicitly validated continuation ancestry are checked separately.

Explicit web roots use HTTP output version 2 to expose observation handles. Joined
HTTP roles inherit that marker. Historical HTTP output version 1 is unchanged;
the marker is separate from the profile and account identity.

## Independent execution

A host-authored `WebVerificationPlan` binds a review digest and hypothesis to
2–8 named cases, including distinct attack and legitimate-control requests,
repeated 2–3 times. Version `zero-web-exact-response-v1` checks exact HTTP status
and SHA-256 of the complete redacted response body. No generated code or regex
is executed as an oracle.

Prepare the plan without contacting a target:

```sh
0sec-native web verify-prepare --session SESSION --plan plan.json
```

Execute the reviewed intent with the returned digest:

```sh
0sec-native web verify --session SESSION --command-id PLAN_RUN \
  --plan plan.json --expected-intent sha256:DIGEST
```

If the inherited policy gates `http_request`, also pass
`--approve-plan sha256:DIGEST`. This authorizes the complete exact matrix. It is
not an implicit approval, an interactive approval for each case, or permission
to change the plan. Preparation grants no permission.

Each case/repeat has a distinct, freshly admitted HTTP effect, dispatched in
repeat-major order. Store checks bind its original review, complete-plan
approval, normalized request, case, repeat and original shared HTTP account.
Rate limits, 429 cooldowns and cumulative request/byte budgets remain shared
with discovery. Existing discovery evidence cannot count as a fresh attempt.
Cancellation after possible dispatch retains uncertainty; retrying a command
reads its receipt and never resumes the remaining matrix automatically.

The state mode is explicitly `same_static_identity_existing_target`. Fresh
connections and model conversations do not reset server state or establish
independent principals. Cookie sessions, login/reauthentication, CSRF lifecycle,
multiple identities, target reset, browser and OAST workflows remain separate
parity work.

Complete stable observations satisfying attack and control expectations can
produce `ObservedForPlan`; a stable attack mismatch with successful controls
can produce `NotObserved`. Missing, unstable or failed controls are inconclusive.
Possible effects that cannot be established dominate as `Unknown`. All results
retain `vulnerability_reportable: false`. Equality of redacted bytes cannot prove
cross-principal disclosure or establish a category-specific vulnerability.

## Inspection, triage and reports

`web runs` discovers partial roots even without a terminal review. `web show`,
`web observations`, `web findings`, `web finding`, `web evidence` and `web range`
inspect retained state. Range reads require the expected manifest digest and
return at most 64 KiB as base64. Empty catalog pages may still carry a continuation
cursor because journal work is bounded independently of matching entries.

`web accept`, `web suppress` and `web reopen` append operator decisions using an
explicit expected revision. Exact retries return the original decision without
reapplying it. Decisions remain separate from verification. Deleted or altered
web decision history fails validation instead of resetting the revision.

`web report --session SESSION --operation WEB_RUN --verification PLAN_RUN`
exports JSON, Markdown or HTML with explicitly selected verification receipts.
Readonly report reconstruction checks retained evidence and reassesses the
matrix; it does not contact providers or targets or resolve current credentials.
Partial evidence and its limitations remain visible. Reports make no implicit
latest-run selection.

SQLite schema 11 adds independent web triage decisions. Existing writable native
databases migrate; readonly readers require the exact current schema. This is
not a legacy TypeScript database importer.

## Qualification scope

Tests use real local HTTP/provider fixtures, retained SQLite databases, tampered
receipts, cancellation and process restart. These establish local execution and
provenance behavior. They do not establish live-provider compatibility,
detection quality, cloud deployment or replacement of specialist security
workflows. Remaining release gates are tracked in [MIGRATION.md](MIGRATION.md).
