# Finite shared holdout authority (#40)

Exposure is keyed by the existing content-based held-out corpus/evaluator
identity using actual sealed content plus the executable evaluator digest; selection
thresholds, profile labels and semantics metadata do not create a new budget.
Case labels/order, campaign names, store paths and copied campaign
ledgers cannot create a new query budget. Every held-out **and negative-control**
execution consumes one slot before dispatch, for both baseline and candidate,
including repeats, failed executions, retention checks and canary evaluations.
Development-only execution consumes no slot. Re-reading an already disclosed
receipt consumes no additional query; any new sealed execution does. Query
reservations are never refunded for rejected, failed or interrupted evaluations.

The shared controller authority defaults to `~/.0/evolution-authority/holdouts`.
`ZERO_EVOLUTION_AUTHORITY_ROOT` is an explicit operator/controller deployment
setting, not candidate configuration. Controllers for the same operator/corpus
must use the same durable private directory, including after migration to another
machine. A campaign binds its first authority directory and rejects a later
change. Do not place this authority in candidate snapshots or disposable stores.
Before upgrading a deployment with legacy store-local ledgers, reopen every
existing campaign under the new controller to import its legacy semantics-keyed
shared record and conservative local exposure
floor before creating new stores; unseen historical stores cannot be discovered
without an operator-provided inventory. Deleting this trusted authority is an operator accounting loss requiring recovery,
not supported rotation. The software cannot prevent a filesystem administrator
from deleting records or intentionally configuring an unrelated trust domain.

Authority debits fsync before the local campaign mirror. A crash between these
writes can conservatively consume an unused query; it cannot make a dispatched
query free. Historical local consumption seeds a conservative floor when first binding
an authority. Legacy reservation IDs deduplicate exact store copies; distinct or
partly overlapping histories conservatively debit their full local totals because
legacy records do not retain per-reservation query counts. This may exhaust
capacity early; it must never undercount independent legacy histories. There is no distributed transaction or exactly-once claim. Each normal
query performs two bounded atomic record writes, under existing controller locks,
with one extra authority write when importing previously unseen legacy history,
and no archive scan. Two lock-owner records are also written/fsynced; normal
reservations perform six fsync calls including ledger directory durability.
The bounded per-identity records are fully rewritten (linear in retained entries,
not constant-size I/O). Records stop at 10,000 reservations per identity; accounting
is not automatically discarded or reset. Exhaustion stops further evaluations
and promotion even from a new empty store. Since exact exhaustion blocks
promotion, preregister enough selection capacity for the full qualification and
leave capacity before the final decision; never raise the limit in-place.
Fresh independently curated content creates a new audited identity; renaming
unchanged content does not. Baseline/candidate private evidence remains outside
proposal prompts and archives. No authority I/O or model call is introduced in
ordinary scans with evolution disabled.

## Measured deterministic qualification

`holdout-authority-io.json` records 100 real shared reservations on macOS / Node24.
It reports measured p50/p95 latency and final authority/campaign byte sizes.
These fsync measurements concern offline campaign control, not selected-artifact
scan latency; filesystem and host contention materially affect them.

`holdout-null-study.json` records 2,000 independently seeded synthetic A/A
campaigns. All candidates have true success probability 0.5. The fixed selection
panel has 64 Bernoulli observations; a score of at least 40 passes. Four-query
and 32-query arms use paired seeds, with no candidate quality advantage. A
separate final RNG is created only after selection has irrevocably finished;
its values cannot select a candidate. Final checks are not retried.

The four-query arm falsely selects 242/2,000 (12.10%; 95% Wilson
10.74–13.60%); the 32-query arm selects 1,240/2,000 (62.00%; 59.85–64.10%).
Independent-final false promotions are respectively 5/2,000 (0.25%;
0.107–0.584%) and 32/2,000 (1.60%; 1.136–2.250%). Both remain nonzero.
These observations demonstrate the limited synthetic effect of bounding selection
opportunities. They **do not establish adaptive validity**, production false
promotion rates, security capability improvement, or independence of real
repository/CVE families. No statistical noise mechanism or correction is claimed.

Production independently curated final corpora, grouped target/repository/CVE
families, actual model/provider costs and primary efficacy outcomes belong to
#120's preregistered qualification. The synthetic final set is not a substitute
for that final corpus, and no paid study was executed here.

Reproduce the fixtures and reports:

```sh
HOLDOUT_NULL_REPORT=/tmp/holdout-null.json HOLDOUT_IO_REPORT=/tmp/holdout-io.json \
  pnpm --filter @0/core exec vitest run src/improvement/safety.test.ts \
  src/improvement/evaluation.test.ts src/bench/holdout-null-study.test.ts
```
