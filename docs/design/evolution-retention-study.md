# Bounded longitudinal retention and paired offline analysis

Issue #37 extends the existing exact-output critical panel. The production
promotion rule remains conservative. A separate, explicit offline analysis can
assess model-backed studies without importing perfect repeat agreement as a
statistical assumption or silently relaxing production gates.

## Promotion continuity

A panel receipt binds its profile ID/version, critical fixture-content cohort,
evaluator identity, and evaluated worker comparison identity. The controller
checks the current active version's immutable configuration and receipt at canary
start and promotion. A previously configured critical panel cannot disappear.
Changed panel/cohort/evaluator identity requires a higher profile version,
`previousProfileDigest` matching the actual prior profile, and a nonempty
operator-reviewed `rotationApprovalRef`. Incomplete prior evidence is not a pass.
The initial baseline has no evaluated profile yet; its configured panel still
cannot be disabled or replaced on the first candidate. An approved initial
rotation references `declaredEvolutionRetentionProfileDigest(previousConfig)`;
there is no need to pretend that initial declarations are evaluated receipts.

This makes a multi-generation failure visible: a candidate can improve new-case
accuracy while failing an old critical capability that the immediate baseline
also fails. The retained panel blocks it. Removing that hard case from the next
panel cannot silently make promotion pass. Fixture names do not define content
identity, and administrative profile names/version bumps do not reset evaluation
semantics or holdout exposure. All transitions remain inside existing receipt,
registry, canary, and compare-and-swap controls.

No extra worker executions are added by the deterministic panel: it consumes the
already-accounted private evaluation attempts. Missing/duplicated repeats,
negative-control failure, interrupted evidence and receipt mismatch fail closed.

## Predeclared paired study contract

`analyzePairedRetention()` is a controller-only offline analysis helper. It does
not dispatch workers, call a model, select candidates, or promote artifacts.
Its explicit protocol requires:

- one pinned evaluated-worker comparison context and an immutable preregistered
  protocol digest;
- a curator-reviewed independent-family sampling reference, profile version, and
  finite list of generations/capability panels;
- separate retention, adaptation, and false-positive panels;
- A/A and deliberately regressing controls in addition to candidate generations;
- declared practical margins, adaptation gain, minimum independent families,
  confidence level, maximum observation rows, and complete evaluated-panel cost ceiling.

There are no universal production margins. A paid study must choose margins and
minimum evidence from its actual contract, pilot variance, and adjudication
policy before inspecting private outcomes. Related repository/target/CVE families
must be grouped before sampling/splitting by the curator. A sampling-reference
string is an audit reference, not proof of independence.

`pairedRetentionObservationsFromReceipt()` verifies an existing evaluation
receipt's digest and pairs its private baseline/candidate executions by case and
repeat. The panel/family mapping stays controller-owned. It refuses development
lanes and duplicate/replayed executions, retains missing pairs as inconclusive,
and never parses a model summary into evidence. `pairedRetentionComparisonDigest()`
binds the actual worker/evaluator/corpus context independently of the proposal
model. The analysis report content-addresses the retained input evidence.

Existing evaluation costs include configured tariff/pricing estimates. The
receipt bridge therefore preserves them as `estimatedCostUsd` and leaves actual
`costUsd` unknown unless a host supplies authoritative reconciled charge evidence
and immutable billing receipt references. Missing invoices cannot manufacture a
paid-study pass. Search/proposal/build overhead outside the evaluated panel must
still be charged by the #120 pilot; panel analysis does not replace its complete
campaign budget.

Every pair contains host verifier outcomes, evidence/authority invariants, model
comparison identity, observed cost, and latency. Repeats from the same family are
averaged within that family and never inflate the independent sample size. The
report excludes family digests, case IDs, expected answers, and trace content.
Unknown charges, changed comparison context, interrupted evidence, insufficient
families, excessive cost, or missing panels produce inconclusive evidence. An
actual evidence/authority invariant failure remains a hard rejection regardless
of statistical results.

## Fixed-study uncertainty

For each generation/capability, the controller computes the average paired
candidate-minus-baseline difference across independent family averages. Each
family average lies in `[-1, 1]`. The two-sided Hoeffding radius is
`sqrt(2 * log(2 * M / alpha) / N)`, where `M` is the predeclared number of
comparisons and `N` the independent families. A finite union bound accounts for
that fixed panel. The reported intervals are deliberately conservative. This is
a direct bounded-independent-variable application of [Hoeffding (1963),
Probability Inequalities for Sums of Bounded Random Variables](https://doi.org/10.1080/01621459.1963.10500830),
with range width two, two tails, and a finite union bound; its assumptions do not
justify adaptive selection on a reused panel.

Retention requires the lower confidence bound to stay above the declared maximum
loss. False-positive analysis requires the upper bound to stay below the declared
maximum increase. Adaptation requires the lower bound to exceed the predeclared
gain. A/A controls require the full interval to remain inside their practical
equivalence margin. An interval that establishes neither safety nor regression
is inconclusive, not a fabricated success. Reports retain A/A rejections and
inconclusives separately.

These bounds assume independent curated families in a fixed predeclared study.
They do not establish adaptive/reusable-holdout validity, independence of real
security fixtures, or practical security benefit. #40 retains authority over
holdout exposure. Selection and an untouched independent final validation remain
requirements of #120; this helper does not authorize a paid experiment or replace
that pilot's cost/reconciliation rules.

## Reproduced controls and overhead

Committed qualification artifacts record two different fixture exercises:

1. A deterministic 400-family panel separates retained capability, adaptation and
   false alarms, accepts an A/A control, and rejects deliberate forgetting even
   while the new-capability panel improves. Charges and latencies in this artifact
   are simulated fixture observations, not provider invoices or real executions.
2. Thirty-two separately seeded synthetic stochastic studies report A/A rejection
   and inconclusive counts, regressing-control detection, Wilson uncertainty
   intervals, and measured analysis p50/p95. These runs test policy behavior and
   uncertainty accounting; they are not measurements of any optimizer or model.

The existing ordinary-scan fixture exercises a mocked direct-provider scan and
records its model invocation count alongside zero critical-panel, paired-study,
and provenance-observation invocations and zero unexpected network calls. It
measures invocation overhead in that fixture, not production scan latency. No
paid calls were made.

Engineering qualification covers multi-generation promotion continuity, approved
cohort rotation, changed evaluator context, insufficient independent families,
correlated repeats, interrupted evaluations, negative controls, cost exhaustion,
unknown charges, deterministic evidence/authority gates, and replayed pairs.
Actual fixed-budget security campaigns with independently curated panels and
provider billing evidence remain outstanding under #120; this PR does not claim
stochastic benefit or close that study.
