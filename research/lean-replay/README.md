# Lean replay model

An educational example for discussing an Engine C formal-verification lane.
It models a known replay-cache composition problem; it is not a TLS stack,
a newly discovered vulnerability, or a production verifier.

`Replay.lean` contains five named theorems:

- Independent per-node caches can accept the same ticket twice across nodes.
- The original node rejects an immediate replay.
- Consuming a ticket records it in the cache.
- A remembered ticket is rejected.
- A single shared atomic cache rejects the immediate second consumption for
  every ticket and every initial cache state.

The model assumes sequential atomic consumption, stable ticket identifiers,
and caches that never expire or reset. It omits authentication, application
retries, concurrent interleavings and the TLS wire protocol. A real deployment
needs separate implementation evidence and a model covering those behaviors.
See the known limitation in [RFC 8446 section 8](https://www.rfc-editor.org/rfc/rfc8446.html#section-8).

## Reproduce

With Elan installed, from this directory:

```sh
lean --version
lean Replay.lean
```

The toolchain file pins v4.35.0-rc4, the version used for the playground check
(a release candidate, not a production toolchain qualification).
This example only imports Std, not Mathlib.
Inspect every `#print axioms` result. No target may depend on `sorryAx`,
arbitrary custom axioms, or native-evaluation axioms under the proposed strict
policy. Compilation alone is not the acceptance criterion.

The official [Lean playground](https://live.lean-lang.org/) can also check this
small file by pasting its contents. The playground's selected version may
differ from the pinned local toolchain; record the actual version used.

## Verification observed

On 2026-10-07, the proof declarations and definitions were checked in the
official playground using its selected Lean v4.35.0-rc4 environment. Its All
Messages pane returned exactly five informational axiom reports, one for each
named theorem, all listing `[propext, Quot.sound]`; no proof errors or warnings
were present. The playground submission omitted the explanatory comments in
this file; definitions, statements and proof bodies were identical.

Local toolchain execution and independent Comparator checking have not been
completed. The slow local toolchain download was stopped. This is a reviewed
educational proof check, not qualification of a production Engine C gate.

## Engine C integration proposal

Add a separate formal-artifact verifier beside the existing structural gate.
The existing `evaluateBoundedCheck` verifies text claims, not their semantic
implication. Keep these evidence bases distinct.

The trusted input must fix the theorem statement, referenced definitions,
assumptions, target source revision and claim polarity before proof generation.
The model can propose proofs and helper lemmas, but cannot silently replace
the question with a weaker statement.

An artifact should retain:

```text
claimId, claimPolarity (violation | invariant), targetSourceDigest,
trustedStatementDigest, modelDigest, theoremName,
proofDigest, toolchainVersion, dependencyLockDigest,
axiomDependencies, checkerIdentity, checkerOutcome,
counterexampleTrace?, implementationReplayEvidence?
```

Run generated Lean/build code in the isolated engine execution profile with
timeouts, cancellation, memory/output limits, and no credentials. Verification
must not trust logs printed by the candidate. For generated or external proofs,
use a trusted challenge and Comparator with an external checker as described
in [Lean's validation guide](https://lean-lang.org/doc/reference/latest/ValidatingProofs/).
Ordinary compilation plus an axiom audit is useful for reviewed examples;
it is not sufficient qualification for an adversarial production proof gate.

Verdicts need two levels:

| Formal outcome | Security implication |
| --- | --- |
| Checked violation/counterexample | Property fails in the stated model; hold real-target confirmation until mapping and replay evidence are adequate. |
| Checked invariant | Property holds under the stated assumptions; do not broadly reject a finding outside that scope. |
| Build failure, timeout, missing checker | Inconclusive; neither a refutation nor a proof. |
| Wrong statement or disallowed axiom | Artifact rejected; the underlying security finding remains unproven. |

A replayed target bug follows existing disclosure/publishability rules.
Formal model evidence alone must not masquerade as a reproduced PoC or add
an uncoordinated value to cloud-parity-locked evidence enums. A workflow template
must not advertise this as an available capability before a real executor,
retained artifacts and negative acceptance tests exist.

## Research directions, checked 2026-10-07

1. **Hybrid TLS implementation conformance.**
   [RFC 10024](https://www.rfc-editor.org/rfc/rfc10024.html) was published in
   August 2026. Test local open-source implementations for required share
   ordering, fixed lengths, encapsulation-key validation, all-zero checks and
   error handling. These requirements are known; a new result would be a
   previously unreported implementation deviation or a new verified property.
2. **Hybrid composition and randomness.**
   The same RFC explicitly identifies transcript dependence and shared faulty
   RNG risks. Investigate a concrete implementation's failure modes and
   assumptions. A generic warning about RNG quality is not a new discovery.
3. **Distributed replay handling.**
   Start with the known counterexample here, then extend to restart, cache
   expiry, routing and application retries in an owned local two-node lab.
   Search schedules with [Tamarin](https://tamarin-prover.com/manual/master/book/001_introduction.html),
   reproduce the witness locally, and formalize a precisely scoped mitigation.
4. **Proof-to-code correspondence.**
   Check what survives parsers, error paths and integration. Existing
   [Project Everest](https://project-everest.github.io/) work provides verified
   components and also documents its verification boundaries.
5. **Mathematical cryptanalysis.**
   Improving attacks on elliptic-curve discrete logarithms or Module-LWE is a
   substantially more speculative research program. [FIPS 203](https://csrc.nist.gov/pubs/fips/203/final)
   describes ML-KEM's security in terms of believed Module-LWE difficulty.
   Lean can validate a formalized reduction or attack bound; it does not make
   a hardness assumption an unconditional fact or turn a toy break into a
   practical attack on deployed parameters.

Recommended first engineering milestone: trusted statement -> generated
proof -> independent check -> retained model evidence, calibrated by this
reviewed example and deliberately invalid candidates. Recommended discovery
milestone: one concrete source-linked conformance hypothesis, tested locally,
with a replayable result and documented novelty check.
