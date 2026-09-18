# Native worker compatibility: actual cloud consumer

Status: 2026-09-18, read-only source audit. No cloud services, credentials,
network operations, scans or consumer tests were executed.

## Evidence pin and correction

The consumer source is available in the sibling `0sec-labs/0cloud` repository at
commit `f3d82724bb556db8b7740b3a5c2e0532cc1e9816`. The inspected worker-controller,
orchestrator and release-manifest paths had no working-tree changes. The engine
gitlink `tools/0sec` is `9c5403d02fdf3b2ad697dddb7af72c2a2339630c`.
`tools/release-manifest.json` declares `contract_version: 0sec-e2b/v1` and pins
an immutable engine image plus an E2B template alias. These are source pins,
not a verification of deployed image/template contents.

This corrects the absent-consumer premise in [CLOUD-WORKER-DESIGN.md](CLOUD-WORKER-DESIGN.md).
The proposal's separate native-operation export remains appropriate, but its
consumer-qualification work can now use actual source and fixtures. Paths below
are relative to the pinned **0cloud repository**, not this public engine tree.
No private deployment identifiers or credential values are required for this ABI.

## Launch, ownership and secrets

- `services/worker-controller/src/runners/scan-prep.ts:339`
  `prepareScanDispatch` consumes a `PendingScan` plus host configuration and
  produces `{args, envs}`. `runners/args.ts::buildScanArgs` chooses real legacy
  commands by mode; for example HTTP audit is
  `0sec scan --target <baseUrl> --mode http_audit --format json`.
  Review, deep review, secure, hunt and other modes have separate arguments and
  prerequisites. There is no generic native operation JSON launch contract.
- `runners/e2b.ts::render0secCommand` invokes the **`0sec`** executable. The
  controller creates an E2B sandbox and tracks its background command promise;
  `runners/msb.ts` is an alternative substrate. Digit-prefixed `0SEC_*` names
  require `splitSandboxEnvironment` and wrapper handling; ordinary POSIX shell
  assignments are not a substitute. `scan-body.ts` stages inputs and invokes
  `sandbox.commands.run` with the prepared environment and timeout.
- `runners/run-storage.ts::sandboxRunStorage` gives each scan private paths:
  `/tmp/0sec-runs/<scan>/state.db` and `report.json`. Dispatch supplies
  `0SEC_RUN_DIR`, `0SEC_DB_PATH`, `0SEC_REPORT_PATH`, `0SEC_CLOUD_SCAN_ID` and
  optional organization context. `runners/select.ts::buildE2bStaticEnvs` adds
  cloud sink URL, cloud event enablement, logging and cost ceiling. Provider
  selection/credentials are resolved per dispatch, not copied as an ambient
  collection of all provider keys.
- `scan-prep.ts::buildHttpAuditEnvs` supplies base URL, JSON allowed host/path
  lists, rate and kill limits; target authentication is decrypted in memory and
  passed only in the relevant process environment. It is distinct from sink
  authentication. Other modes do not inherit the HTTP-audit profile.
- `scan-prep.ts::buildScanIngestionEnv` mints a short-lived scan-and-organization
  capability when configured. `services/orchestrator/src/app.ts:315` accepts it
  only for POSTs to that scan's events/findings/artifacts routes and checks the
  organization. The trusted controller's bearer remains separate. Do not move
  controller credentials into a native execution guest.
- `E2bScanRunner.cancel` kills the owned sandbox; drain/reap paths await tracked
  work and classify interruptions separately. A Rust subprocess's cancellation
  token alone cannot replace the controller's sandbox lifecycle contract.

## Three distinct output contracts

| Channel | Actual consumer requirement | Consequence for native integration |
| --- | --- | --- |
| Generic terminal marker | `runners/e2b.ts::hasClean0secResult` parses the first matching single-line `0SEC_RESULT={...}` and treats only `exit_reason: completed` or `findings` as clean nonzero completion. `scan-body.ts` uses this for command exits. | A marker is not the final report; do not emit multiple conflicting terminal markers or assume any valid JSON makes a nonzero exit successful. |
| Progress events | `poller.ts::parseEventLines` lowercases the `0SEC_EVENT_*` suffix and requires object JSON (or an absent body interpreted as `{}`). `e2b.ts::makeStreamingEventRelay` buffers arbitrary stdout chunks and posts `{event_type,payload}`. The event route requires a UUID scan, event type length 1–64 and object payload. | Preserve newline framing and cumulative usage semantics. There is no native app-server event envelope substitution. Stderr is relayed as unstructured text, not parsed as engine event authority. |
| Final generic report | `scan-body.ts:864` reads `0SEC_REPORT_PATH` through sandbox file access; `parseFinalReport` requires `findings[]` and integer `summary.totalFindings` equal to its length. Only a missing file permits fallback to an entire structured stdout JSON report. It then calls the controller's final-report publisher. | An artifact attachment or `0SEC_RESULT` line alone is insufficient. The native operation export intentionally fails this contract; do not fabricate empty findings/summary to make it pass. |

The orchestrator's `routes/scans.ts::scanReportSchema` requires `target`,
`startedAt`, `completedAt`, `durationMs`, `warnings[{stage,message}]`,
`findings[]`, and summary counts `totalAttacks`, `totalFindings`, `critical`,
`high`, `medium`, `low`, `info`; `scanDepth` defaults to `deep`. Optional fields
and passthrough metadata do not relax those semantic requirements. Final ingest
is `{report, final:true, raw_log?}` at `/scans/:id/findings`; per-finding ingest
is `{finding, feature_vector?}`. The finding schema is owned by
`packages/cloud-contracts/src/finding.ts`, including executable verification
payload validation, not inferred from the permissive nested report array.

Secure mode is separate: `0SEC_SECURE_EVENT={...}` becomes a
`secure_phase_event`; `parseSecureResultLine` expects a terminal `status`.
The orchestrator accepts `{secureResult, final:true, secure?:true, raw_log?}`
with status `completed|blocked|failed|cancelled` and required `phase`. Do not
present native `ValidatedCandidateForPlan` as a complete secure pipeline result.

## Delivery and accounting implications

`services/worker-controller/src/cloud-sink.ts::HttpCloudSink` posts with its
trusted bearer and retries transport failures, 429 and 5xx using a finite retry
schedule; other 4xx fail immediately. This differs from the engine producer's
best-effort direct sink. The controller now owns report recovery and completion;
adding another native final publisher risks duplicate delivery. Final-report
fan-out is idempotent by finding fingerprint, and terminal scan guards avoid
reapplying fresh-completion billing on retries (`routes/scans.ts:2293`).

The progress relay has an in-memory 5,000-event buffer and evicts oldest entries
on overflow. It is not a durable reconnect journal. Retry count/backoff bounds
also do not establish a total transport deadline for each fetch. Preserve these
limitations in qualification rather than claiming delivery exactly once.

`routes/events.ts:230` promotes **running totals** from `cost_update` using
`cost_usd`, `token_input`, `token_output`; adding repeated events is incorrect.
`scan_completed` also drives terminal status: cost ceilings and turn caps must
not be relabeled clean completion. Native integer budget units still require
explicit USD/rate provenance before becoming `cost_usd`. Missing usage and held
reservations are not zero cost.

## Concrete consumer acceptance fixtures

Run these only as local mocked contract tests after adding a native adapter;
this audit did not execute them:

- Worker `src/__tests__/args.http-audit.test.ts`, `runners.test.ts`: exact argv,
  environment separation, per-scan capability, nonzero terminal markers,
  fragmented event lines, replay buffer and cancellation ownership.
- Worker `src/__tests__/scan-body.report-recovery.test.ts`: authoritative report
  file, missing-file stdout fallback, fail-closed missing/invalid report, stderr
  framing. Feed native candidate output into this seam; do not weaken its shape
  checks to accept an unrelated operation export.
- Worker `src/__tests__/cloud-sink.test.ts`: exact paths/bodies, retryable versus
  terminal failures; add duplicate/lost-response fixtures for a native publisher
  only if ownership explicitly moves out of the controller.
- Orchestrator `src/__tests__/events.test.ts`, `scans.test.ts`: scan-bound token,
  cross-scan/expired rejection, object payload validation, cumulative usage,
  terminal transitions, report schema, repeated findings and completion effects.
- `packages/cloud-contracts/src/finding.ts` and its tests: normalized findings,
  executable verification schemas and evidence authority. Native unverified
  source hypotheses and exact-output fixture observations do not automatically
  satisfy these finding semantics.

The next managed slice should preserve the controller and add an explicitly
selected native worker mode with one honestly supported workflow. It needs a
matching result/evidence consumer before it can occupy an existing scan mode.
Renaming `0sec-native` to `0sec`, emitting a success marker, or uploading its
operation envelope is not a cloud migration. No deployment qualification or
scanner-quality claim follows from this source audit.
