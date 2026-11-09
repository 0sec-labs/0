# Finite synthetic source-review decision

Status: offline preflight only; no model execution authorized. This is a fresh
constructed corpus, separate from the historical package corpus and its reused
controls. It can answer whether one candidate helps on these mechanisms, not
whether evolution improves real-world vulnerability detection.

## Freeze before dispatch

- Workflow: JavaScript prototype-pollution source review, structured verdict plus
  exact path explanation. Frozen baseline: `BASELINE_SKILL` in `protocol.mjs`.
- Corpus: nine `scripts/security-evolution-study/finite-fixtures` sources;
  recursive merge for development, dotted traversal for selection, inherited
  registry entry for final. Each has vulnerable, fixed and clean variants.
- Oracle: `finite-preflight.mjs` runs a concrete pollution payload and benign
  behavior check in a fresh Node process per case. These authored files have
  no external dependencies or target traffic. This is process hygiene, not a
  sandbox for arbitrary submitted code. Model findings need independent
  path-level adjudication, not a literal sink match.
- Another reviewer must independently inspect labels, exploit reachability,
  benign behavior, duplication and split leakage before signing the corpus
  digest. The author cannot mark independent review complete. Current status
  remains pending. Constructed mechanisms are not independent real-world families.
- Pin exact provider, dated model, endpoint identity, runtime/build/source hashes,
  baseline/proposal text hashes and actual supported decoding settings. Missing
  or unsupported identity fields remain unknown. Preserve call receipts and
  token counts; tariff estimates do not establish invoice charges.

## One experiment, no expansion

Proposed maximum: **40 total model calls, $5 reserved model spend, 10 minutes**,
with one repeat and at most 4,096 output tokens per call. These limits require
explicit approval and predispatch tariff validation; they are not current
execution permission. Stop further dispatch on unknown usage or identity drift;
retain unresolved reservations and never blindly replay. Include rejected drafts,
failures, evaluation and proposal work in totals. Separately report unpriced local
compute and unreconciled invoice amounts as unknown.

Declare 34 calls: nine frozen-baseline evaluations, one width-one text proposal,
nine candidate evaluations, nine additional frozen-baseline evaluations, three
final A/A controls and three final injected-regression controls. The extra-baseline
arm has ten additional-call slots (nine scheduled plus one reserved retry), matching
candidate development/evaluation plus proposal; compare actual cost as well as
maximum allocation. No other retries or proposals. Unused slots stay unused.

Only positive development evidence enters the proposer. Negative development
cases and all selection/final cases stay controller-owned. Choose candidate versus
baseline using development results, then freeze it before selection/final testing.
Final observations never request another draft. The source reviewer receives
opaque source identities, not filenames identifying the label or split. A reviewer
who sees final cases must not contribute proposal text or model feedback.

Primary decision: retain the candidate for a further separately approved evaluation
only if it improves correctly adjudicated vulnerable detections over both the frozen
baseline and extra-attempt comparator, introduces no false alarm or lost baseline
success, and stays within the declared cost/time limits. Require all controls to
behave as expected. Report every case outcome, wall time, CPU time and all usage;
with this sample, tail latency and generalization remain unknown. Ties, missing
billing/identity evidence or inconclusive results retain the baseline and end this
pilot. No default changes, automatic promotion, corpus enlargement or repeat until
positive follows from this decision.

## Offline reproduction

```sh
node --test scripts/security-evolution-finite-preflight.test.mjs
node scripts/security-evolution-study/finite-preflight.mjs > /tmp/finite-preflight.json
```

The report hashes sources and oracle and marks independent review pending. It
cannot close #120 by itself. Existing `run-security-evolution-study.mjs` admits
its historical corpus/protocol only; this plan must not be passed to that runner
as if it supplied an independent semantic model-result oracle.
