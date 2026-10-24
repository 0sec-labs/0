# Durable campaign dispatch qualification (#41)

This change completes controller-boundary engineering checks for explicit offline
campaigns. It does not enable a multi-day scheduler or execute a paid campaign.

Dispatches already reserve before model/worker execution and settle observed
charges afterward. Unknown or missing provider/execution usage blocks further
spending until explicit reconciliation with a charge and immutable receipt
reference. A crash after reservation is ambiguous even when the provider may not
have received the request; recovery never assumes that request was free.

Reservations now bind the unique pass lease as well as PID. A later pass or a
reused numeric PID cannot masquerade as the original dispatcher. Foreign
controllers cannot mutate a campaign while another process owns its pass;
ordinary settlement by a different owner must use the reconciliation path.
Legacy pending records without a matching current pass token fail closed when
opened under a pass lease. Stale/partial/invalid controller locks retain the
existing explicit recovery rules; no claim of arbitrary corruption recovery or
exactly-once external API calls is made.

Before every safety-enabled proposal dispatch, preflight counts the entire
configured baseline/candidate evaluation and all declared canary trials:

`cases × 2 variants × repeats × (1 + canaryTrials)`

It checks bounded dispatch-record capacity, reserves worst configured compute
cost, and keeps declared model-worker validation capacity out of the proposal
spending allowance. Pending and settled durable charges count. A model is not
called when complete configured validation cannot fit. This can reject otherwise
cheap realized runs: timeout-based compute limits are intentionally conservative.
It is not a hard provider billing cap; actual charges and incomplete usage still
settle or block. Configured canaries reuse the configured corpus; they are not a
fresh-corpus generalization claim. Independently curated final studies and
unattended expansion remain gated on #120.

## Real subprocess crash fixtures

`campaign-process.test.ts` builds and launches the actual ledger/controller
modules in separate Node processes. Parent tests wait for a named boundary,
SIGKILL the dispatcher, then start a fresh controller. The deterministic external
boundary appends one observation marker; it is not an HTTP provider or a billed
request. Covered boundaries are:

- after owner acquisition and before any dispatch reservation: no invented spend;
- after reservation but before the external observation: unknown charge blocks;
- after external observation and before settlement: unknown charge blocks, marker
  count stays unchanged across restart (no replay);
- an evaluation-kind dispatch in flight: unknown execution charge blocks;
- after completed settlement and before a subsequent promotion step: known spend
  persists exactly once;
- a live competing process: it cannot acquire or mutate the same campaign;
- a different pass with the same PID: its old unresolved reservation blocks.

Tests then reconcile the ambiguous fixture receipts explicitly. They do not
silently redeliver a request, mutate candidate bytes or claim full CLI/VM/provider
crash qualification. Existing evolution evaluation and loop tests continue to
cover actual dispatch integration, observed model charges, canary rollback,
receipt integrity and version-pinned execution. No ordinary scan path performs
these campaign transactions. No new background polling or automatic wakeup was
added: a no-change watch pass stops; a later explicit run is an operator request.
Multi-day approved-feedback wakeups remain phase two after the finite pilot.

## Measured overhead

`campaign-dispatch-io.json` reports 100 actual reserve/settle pairs with file and
directory fsync under the pass lease on macOS / Node24. The observed reservation
p50/p95 were approximately 52/82ms; settlement 54/76ms; final ledger size was
37,627 bytes. These host-contention-sensitive numbers describe explicit offline
controller accounting, not selected-artifact scan latency. The report contains
no paid calls or extrapolated provider cost. Storage and dispatch count remain
bounded by the existing 10,000-record campaign cap. Transactions occur at
external-dispatch/state boundaries, never per token or ordinary tool event.

Reproduce the process tests and overhead artifact:

```sh
CAMPAIGN_IO_REPORT=/tmp/campaign-io.json pnpm --filter @0/core exec vitest run \
  src/improvement/campaign-process.test.ts \
  src/improvement/campaign-validation-budget.test.ts \
  src/improvement/safety.test.ts src/improvement/evaluation.test.ts \
  src/improvement/loop.test.ts
```
