# Offline measured fixture evaluation

This controller executes two immutable plugin generations in separate private
registries through `zero-plugin-runner`. It never grants production eligibility,
imports a receipt, changes production state, or activates a production graph.
`Report.decision = Eligible` means only that its explicit frozen fixture criteria
passed; it is not a detector-quality claim or an authorization token.

`Evaluation::create(new_private_root, &source_registry, plan, &host_grants)` copies
verified artifact closures into two fresh registries, locally bootstraps each
unmeasured variant and prepares its graph. Source registry access is read-only.
The complete plan, including expected answers, stays in the private controller
ledger. Guests receive only tool input and pinned plugin dependencies. This is
not privacy enforcement against another process using the same host account.
The root's ancestor namespace and controller are trusted. Evaluator/engine
artifact bytes are retained identities supplied by the host, not runtime binary
attestation. Only existing immutable backend images/archives are accepted.

`run(&runner, cancellation)` executes an alternating, complete paired schedule
in fresh offline guests. One tool/plugin and one identical host launch profile
apply to both variants. Resource and policy changes between generations reject.
Runner JSON replies, exit/cleanup observations and observed backend identities
produce scores; the caller never supplies a pass boolean. Expected values use
`serde_json::Value` equality: object order is immaterial, arrays ordered, numeric
representations follow serde_json equality (no JS number coercion). The runner's
JSON decoder is authoritative; duplicate JSON object keys follow its parser
semantics, so this version does not claim duplicate-key rejection.

The gate requires all case/repeat/variant entries, successful executions with
confirmed settlement, stable exact outputs across repeats, no lost baseline
success, all candidate negative controls matching, and the specified additional
solved **distinct** development/held-out case counts. An invalid execution,
missing pair, unknown effect or unstable output is Inconclusive. A fully observed
policy mismatch is Rejected. Negative-control mismatch is not labeled a
vulnerability false-positive rate. Corpus independence/provenance and protection
against adaptive held-out selection are operator responsibilities in this version;
no source-rewriting feedback loop is exposed.

SQLite intent precedes lease acquisition and staging. A prepared request digest,
execution ID, lease ID and staging path are committed before runner dispatch.
Outcome is committed before release in the separate evolution database; settlement
is marked only after explicit release. Dropped waiters cancel the runner's owned
task without aborting it. Reopening requires an exclusive stable lock, rejects
DB/lock hardlinks and leaf symlinks, and turns interrupted Preparing/Running into
Unknown. It never resumes or replays a schedule, even if preparation had not
launched a guest. Unfinished leases and recovery paths remain available in the
private registry and attempts. Fencing/inspection/disposal remains manual; opening
the ledger does not prove an old guest is dead. There is no recovery API that
silently releases Unknown leases. A crash before backend-generated recovery IDs
are observed can require backend-owner discovery; the ledger retains the known
execution ID and staged request identity, not a fabricated cleanup claim.

Accounting is bounded **execution slots**, not monetary spend: attempt intent
reserves one slot, confirmed settlement consumes it, Unknown retains it. Maximum
attempts, time/output per attempt and aggregate evidence are fixed before running.
This crate does not call providers or calculate cloud invoices. A future monetary
budget must reserve compute/provider dimensions separately with real reconciliation.
There is no automatic retry or completed-work replay to spend a second allowance.
`run` on a completed ledger returns the same receipt identity; evidence/report
integrity is recomputed from retained outcomes before returning a stored receipt.

The report binds baseline/candidate, engine/evaluator artifacts, private plan,
separate host-grants and scoring-policy digests, and the complete attempt evidence
index. Its digest hashes serialization with an empty receipt_digest field. It is
not a cryptographic signature, independent evaluation attestation, or a complete
portable production-import bundle. Plan/oracle and raw evidence are retained in
the private ledger; export/redaction, authority-verifying import, monetary budgets,
canary rollout and autonomous source rewriting are deliberately future work.

Default tests use the actual runner with a subprocess Docker fixture and qualify
logic/lifecycle, not OS isolation. The ignored `real_local_docker_*` test executes
both JavaScript artifacts in existing local Docker containers with:

```sh
ZERO_EVALUATION_DOCKER_IMAGE=sha256:<existing-local-image-id> \
  cargo test -p zero-evaluation --test evaluation -- --ignored
```

It never pulls an image. The fixture needs Node available as `node` in that image.

`Evaluation::inspect(root)` opens a read-only SQLite snapshot without taking the
owner lock or rewriting interrupted attempts. Its bounded serialized summary
contains run/plan identity, attempt-state counts, slot totals and an optional
verified report; it exposes no inputs, expected answers or raw output. It works
while the controller still holds its exclusive ownership lock. `reopen` remains
an explicit recovery action and is not used for ordinary status inspection.
Reads check SQL byte lengths before materializing JSON and enforce a 32 MiB total
serialized-attempt limit, 512 KiB per attempt, 1 MiB plan and 64 KiB report. Before
each dispatch the writer reserves room for one full maximum-sized attempt. Lack
of evidence capacity stops scheduling as Inconclusive, without truncating output
or starting another guest. These serialized limits include JSON/base64 expansion
separately from the plan's raw output allowance.
