# Native report and worker framing compatibility

This crate provides report models, local atomic JSON replacement, and explicit
stdout framing. It executes no scanners, creates no findings, subscribes to no
events, reads no environment implicitly, and uploads nothing. CLI integration,
HTTP final-sink authentication/retries, dashboard report rendering and specialist
report production remain separate migration work.

`FinalReport` is a versioned local envelope retaining the caller's original report
object, command, explicit outcome/completeness, optional summary, and optional
cumulative accounting snapshot. `write_final_report` validates before writing.
`write_report` is a generic atomic JSON writer for already validated legacy
payloads. Unknown finding counts or cost remain absent instead of becoming zero.
Nested scanner findings and repairs retain their supplied JSON schemas; this
crate does not validate their security evidence.

`FinalReport::run_result` constructs the generic run terminal payload, preserving
`exitCode`, `exit_reason`, `targetType`, `cost_usd`/`estimatedCostUsd`, token aliases,
usage and summary. Run outcomes map to 0 completed, 1 findings, 2 error, 4 cost
ceiling, and 130 cancelled. Partial work cannot claim completed/findings. The
caller must decide the outcome from actual execution evidence; the adapter does
not infer clean execution from empty findings. Cancellation is an explicit native
extension; workers will not classify it as clean completion.

`SecureResult` and `secure_result_line` preserve the separate secure envelope:
status completed/blocked/failed/cancelled maps to 0/2/3/130. They never substitute
generic `exit_reason` for secure `status`. `WirePolicy::secure_event_line` emits
`0SEC_SECURE_EVENT=<JSON>`, which differs from event-bus framing.

`WirePolicy::from_lookup` reproduces current environment semantics exactly:

- Results: `0SEC_EMIT_RESULT_LINE` equals `1`, OR `0SEC_CLOUD_SINK` is nonempty.
  Even `0` or whitespace in the latter enables stdout output. No URL is contacted.
- Events: `0SEC_CLOUD_EVENTS` is nonempty, is not `0`, and case-insensitively is
  not `false`. Values are not trimmed. `0SEC_FEATURE_CLOUD_SINK` does not disable
  stdout markers; it governs a separate HTTP upload implementation.
- Disabled outputs return `None`. Enabled outputs are one compact JSON object
  per newline; JSON strings escape embedded newlines. Event names accept only
  ASCII alphanumerics/underscore, preventing prefix injection.

`CostSnapshot` explicitly identifies session, sequence and provenance. Values are
cumulative snapshots, not additive deltas. It mirrors both `input_tokens` and
`token_input` (likewise output), retaining optional cached input. Missing usage
is omitted; nonfinite/negative dollar amounts and impossible cache counts fail.
Native integer accounting must only convert to `cost_usd` when its currency is
actually USD; this crate does not assume arbitrary budget units are dollars.

The existing orchestrator still uses a decrease/reset heuristic to sum cost
segments and does **not** consume the new provenance fields. Callers must emit
ordered totals for one scan scope; interleaving independent session totals or
replaying old snapshots as fresh cost events would corrupt that legacy sum.
Full cloud acknowledgement/deduplication is not implemented here.

Atomic writes serialize first, create a private temporary file in the destination
parent, write and sync it, then atomically persist over the destination. The
parent must already exist. Serialization/write/sync/rename failure leaves the
previous destination intact and removes the temporary file. This is atomic
visibility, not a claim of crash durability for the parent directory entry; no
directory fsync is performed. Concurrent successful writers are last-writer-wins.

## Contract sources and tests

Public engine sources inspected in this worktree:

- `packages/cli/src/commands/run.ts`: `ResultLinePayload`, `emitResultLine`, final
  reason/exit classification and optional accounting aliases.
- `packages/cli/src/commands/__tests__/run.test.ts`: clean result fixture uses
  `https://example.com`, target type `url`, runtime `auto`, format `json`.
- `packages/core/src/events/bus.ts`: `cloudEventSink`, environment truthiness,
  `CostUpdatePayload` dual token spelling.
- `packages/core/src/events/bus.delta.test.ts`: turn 7, recon/reasoning, sequence 4
  delta fixture used by the golden test.
- `packages/cli/src/commands/secure.ts` and `packages/core/src/secure/types.ts`:
  separate secure terminal/event formats and exit codes.

Read-only consumer verification in sibling `0sec-labs/0cloud`:

- `services/worker-controller/src/poller.ts::parseEventLines` trims lines,
  lowercases event suffixes, forwards object payloads, drops malformed JSON.
- `services/worker-controller/src/runners/e2b.ts`: `parseSecureResultLine`,
  `parseSecureEventLines`, `hasClean0secResult`. The last recognizes only
  `completed` and `findings` as clean generic terminal reasons.
- `services/orchestrator/src/db.ts::updateScanCostFromEvent`: decrease/reset
  segmentation and dual-spelling consumption limitations described above.

Tests are self-contained fixtures derived from these sources, not imports of
private cloud code. Run `cargo test -p zero-cloud-compat --locked`. They cover
wire bytes/semantics, env gating, exits, partial/unknown accounting, secure
framing, injection rejection, atomic replacement and failure preservation.
