# Local security proof demos

Run the traces and bounded exhaustive checks from the repository root:

```sh
node research/security-proof-demos/run.mjs
node research/security-proof-demos/server.mjs
```

Open `http://127.0.0.1:4187` for the interactive step-through. The server uses Node
built-ins, binds to loopback, and serves only this lab and its generated evidence.
Set `PORT` to change the port. No credentials, live targets, or dependencies required.

The three examples show known bug classes, not novel vulnerabilities:

| Demo | Failure | Corrected model property |
| --- | --- | --- |
| Tenant authorization | A login-only guard accepts a different tenant's resource | Accepted access requires matching ownership |
| Stale balance | Two requests reuse balance 10 and each pay 7; balance + paid becomes 17 | Atomic conditional payment conserves balance + paid |
| Nonce rollover | A two-bit counter emits nonce 0 again at position 4 | Distinct accepted counter positions emit distinct nonces; reject at exhaustion |

The JavaScript checks cover 81 tenant combinations, 55,566 two-payment sequences,
and 1,353 nonce positions across limits 0–32. They validate executable behavior in
these finite ranges. They are not universal proofs. Natural-number Lean theorems
have universal scope **within the formal definitions**, subject to their assumptions.

## Check Lean

The toolchain is pinned in `lean-toolchain`; these proofs need only `Std`.

```sh
cd research/security-proof-demos
lean SecurityDemos.lean
```

Install the pinned Lean toolchain via your normal Lean/elan installation first, or
paste the exact file into the official Lean playground with the matching version.
Every named theorem has `#print axioms`. Inspect all reports and reject `sorryAx`.
Ordinary Lean logical axioms such as `propext` and `Quot.sound` may appear; they are
not implementation or cryptographic assumptions.

The UI defaults to **pending**, even though the source contains proof scripts. To
show a recorded successful checker observation, `verification.json` must contain:

```json
{
  "status": "verified",
  "sourceSha256": "SHA-256 of the exact SecurityDemos.lean bytes",
  "toolchain": "leanprover/lean4:v4.35.0-rc4",
  "method": "official-lean-playground",
  "checkedAt": "ISO timestamp",
  "errors": 0,
  "axioms": [
    { "theorem": "ZeroSecurityDemos.tenant_isolation", "axioms": [] }
  ],
  "checkerOutput": "Actual checker output including all eight theorem axiom reports"
}
```

The sample is intentionally incomplete: include actual axiom reports for **all eight**
named theorems. `method` also permits `local-lean`. The importer requires the exact
source hash/toolchain, timestamp, zero errors, every theorem report, and no `sorryAx`.
This file is a recorded observation, not a signed attestation; the UI does not rerun
Lean. Independently rerun the checker to verify the record.

Observed verification: all eight theorems passed in the official playground
on Lean v4.35.0-rc4; the retained source-bound report lists only standard axioms
(`propext`, `Quot.sound`) or no axioms. An unnecessary-tactic warning was removed
and the exact revised source was rechecked. This observation is not an
independent Comparator certificate and has not been used to claim production
formal-artifact acceptance.

## Zero orchestration

The first internal core APIs now exist:

- `verifyFormalArtifact` checks a trusted independent-checker receipt against
  an immutable statement/model/source/proof/toolchain binding and fresh nonce.
- `runFormalResearchCampaign` schedules independent claims with bounded
  concurrency, per-claim/global attempt caps, a wall-clock deadline and
  cancellation. It sends previous checker outcomes to the proof generator and
  optionally retains challenge, proof and result JSON in a fresh run directory.

The engine host supplies a provider/cost-ledger-aware generator and an isolated
Comparator plus external-checker backend. No such production backend is
automatically installed or enabled by this change. Missing checkers stay
inconclusive and the campaign spends no generation attempts on them. These APIs
do not advertise a new CLI/browser/MCP workflow or convert model evidence into
a reproduced target finding. See `packages/core/src/research/formal-campaign.ts`
and `packages/core/src/verify/formal-artifact.ts`.

Parallel agents should own independent hypotheses or theorem dependencies;
the coordinator owns the trusted question and a separate checker validates
results. More agents are useful only when their tasks have a measurable oracle.

## Limits that matter

Tenant identity and resource ownership must be trusted and stable during the check.
The payment fix assumes atomic sequential transitions; real concurrent code needs
a database transaction/conditional update or equivalent synchronization. JavaScript
examples use nonnegative safe integers only; the Lean model uses unbounded `Nat`.
Nonce freshness requires an atomic persistent counter with no rollback/reset under
the same key and a unique nonce domain. No theorem proves cryptographic security.

There is no verified compiler correspondence between these Lean definitions and
Node.js. The payment model abstracts external payment effects into `paid`; it does
not model transaction failures or retry/idempotency. These labs can seed Zero's
proposal → counterexample → checker workflow, but production security findings
still require a connection to the actual implementation and a local reproduction.
