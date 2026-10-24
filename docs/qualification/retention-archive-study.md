# Retention panel and archive policy qualification

These controls run only during explicitly selected offline evolution. They add
no model calls or evaluation work to ordinary scans. They do not establish a
measured benefit for archive exploration or stochastic model retention.

## Deterministic critical panel

An operator can declare a bounded, versioned retention profile in the existing
evolution config:

```json
{
  "retentionPolicy": {
    "profileId": "parser-authority-v1",
    "version": 1,
    "criticalCaseIds": ["old-parser-crash", "safe-parser-control"]
  }
}
```

The IDs reference existing held-out or negative-control fixtures. The full
configured evaluation already executes these fixtures, so the gate reuses its
charged execution receipts rather than starting a second suite. All declared
repeats of every critical case must match with complete, conclusive evidence.
This blocks a candidate that loses an older capability even if the immediate
baseline also fails that capability. The existing baseline-success retention,
negative-control, lift, cost and repeat-stability gates remain in force.

Receipts bind profile version and content identities; case renaming does not
change content identity. Changed fixture bytes or a profile revision produce a
new identity. Private profile IDs/case outcomes never enter development feedback
or parent ranking. Only an opaque digest, pass status, panel size and generic
failure reasons appear in the retention summary. Historical config and receipts
retain the full controller-side audit record.

This hard gate applies to deterministic exact-output workers. It does not supply
paired stochastic noninferiority tests, minimum sample sizes or practical
regression margins. Those must be preregistered from pilot variance before
qualifying model-based workers. Profile maintenance is operator-owned: deleting
a hard case is a contract revision requiring review, not proof of improvement.

## Archive selection experiment

Production already supports opt-in bounded alternative-parent exploration using
compatible, integrity-checked snapshots and development-only match fraction.
`maxAlternativeParents` remains disabled by default. Selected ancestors supply
proposals; their archived promotion status never authorizes activation. The new
`selectArchiveStudyParent` function provides three offline study arms:

- `current`: keep the currently selected parent;
- `uniform`: deterministic seeded hash ordering across the admitted archive;
- `development-diversity`: prioritize cases solved on every repeat that the
  current parent does not solve, then overall development fitness.

The behavior descriptor consists only of development cases solved on every
repeat. It can retain an unsuccessful stepping stone that solves a different
subset; it does not equate source distance or branch count with quality. Inputs
are bounded to ten admitted candidates, twenty repeats and twenty thousand
observations per candidate. Missing/duplicate repeats, sealed lanes and
incompatible development case sets are rejected. Callers must first apply the
existing snapshot, ancestry, trust-boundary and receipt admission checks; the
study selector itself accepts development projections, not source snapshots.

Predeclare paired seeds and the same total optimization spend, worker limits,
editable surfaces, model, development feedback and final validation reserve in
all arms. Include all attempted, rejected, inconclusive and final executions in
cost/latency reports. Report per-capability adaptation, critical retention,
false positives, median/best outcomes and uncertainty. Never send final/holdout
scores or identities to this selector. Do not combine parent-selection and
feedback-summary experiments until their independent effects are measured.

No paid campaign outcomes have been measured by the deterministic unit tests.
Archive strategy expansion remains deferred until independently curated pilot
and final sets demonstrate useful benefit at the predeclared budget. A negative
or inconclusive result retains the simpler production policy.
