# Native managed-worker compatibility design

Status: producer implemented; matched cloud consumer pending. The experimental
`managed-http` producer has explicit grant binding and native terminal files.
It does not perform completion uploads or replace managed dispatch. Existing
hosted authentication, cloud metadata and legacy framing remain separate.

The next matched native HTTP slice is specified in
[NATIVE-WORKER-CONTRACT.md](NATIVE-WORKER-CONTRACT.md), following the standalone
scan implementation. That proposal supersedes the initial exporter-first sequence
below; its cloud dispatch and consumer work still requires implementation and
matched qualification.

## Existing contract, traced from repository sources

The managed worker/controller source is available in the sibling `0cloud`
repository. The [consumer audit](CLOUD-CONSUMER-AUDIT.md) pins its source and
corrects the initial producer-only assumptions. The table below records the
legacy producer; it is not a claim of native deployment compatibility.

| Boundary | Actual producer behavior | Source |
| --- | --- | --- |
| Invocation | `scan --mode http_audit` resolves target/environment inputs into `RunOptions`, then passes scope/auth/rate/kill settings into core. There is no generic job JSON or job-submission endpoint established by these files. | `packages/cli/src/commands/scan.ts:393`; `packages/cli/src/commands/run.ts:639` |
| Target | `0SEC_TARGET_BASE_URL` takes precedence when deriving the base host; otherwise the command target is used. | `packages/cli/src/commands/scan.ts:98` |
| Scope | `0SEC_TARGET_ALLOWED_HOSTS` and `0SEC_TARGET_ALLOWED_PATHS` are JSON arrays of strings. Empty host lists default to the base host; empty path lists allow all paths within host scope. Malformed values fail before scanning. | `packages/cli/src/commands/scan.ts:56`, `:107` |
| Limits | `0SEC_TARGET_RATE_LIMIT_RPS` defaults to 5; `0SEC_TARGET_KILL_AFTER_SEC` defaults to 1800. The parser accepts finite nonnegative integers, including zero; downstream enforcement must determine zero's meaning. | `packages/cli/src/commands/scan.ts:75`, `:119` |
| Target authentication | `0SEC_TARGET_AUTH_JSON` overrides the command's `--auth` in HTTP-audit mode. Authentication is a bearer, cookie, basic, or custom-header configuration. This is not the cloud sink token. | `packages/cli/src/commands/scan.ts:400`; `packages/shared/src/types.ts:16` |
| Result line | `0SEC_RESULT={JSON}\n`, enabled by `0SEC_EMIT_RESULT_LINE=1` or any nonempty `0SEC_CLOUD_SINK`. This gate does not require scan ID or enabled HTTP upload. Whitespace and the string `0` are truthy sink values for this particular gate. | `packages/cli/src/commands/run.ts:217`, `:287` |
| Generic terminal fields | `ok`, `exitCode`, `exit_reason`, `target`, `runtime`, `format`; optional `targetType`, `cost_usd`, `estimatedCostUsd`, `token_input`, `token_output`, `usage`, `finding_count`, `summary`, `error`. | `packages/cli/src/commands/run.ts:217`, `:826` |
| Generic exits | 0 completed; 1 critical/high findings; 2 error or failed AI research; 4 cost ceiling, preserving partial results. Secure has a separate terminal schema and exit classification. | `packages/cli/src/commands/run.ts:796`, `:817`; `rust/crates/zero-cloud-compat/src/lib.rs:45` |
| Event line | `0SEC_EVENT_<TYPE_UPPER> {JSON}\n`. `0SEC_CLOUD_EVENTS` enables the sink unless empty, `0`, or case-insensitive `false`. | `packages/core/src/events/bus.ts:986`, `:1008`; CLI subscription `packages/cli/src/index.ts:43` |
| Local event consumer | The local dashboard bridge parses the uppercase event prefix plus JSON and translates recognized event types. This is not the deployed managed-worker parser. | `scripts/serve-events.mjs:124` |
| Usage event | `cost_update` contains cumulative running totals, not incremental deltas. Tokens use both `input_tokens`/`output_tokens` and `token_input`/`token_output`; cached-input tokens are optional. | `packages/core/src/events/bus.ts:99`; `packages/core/src/agent/native-loop.ts:1998` |
| Sink configuration | `0SEC_CLOUD_SINK`, `0SEC_CLOUD_SCAN_ID`, optional `0SEC_CLOUD_TOKEN`, optional `0SEC_CLOUD_ORG_ID`; cloud-sink feature gating can disable uploads. Core trims these values, unlike result-line truthiness. | `packages/core/src/cloud-sink.ts:83`; final-run gate `packages/cli/src/commands/run.ts:291` |
| Sink request | POST `${sink}/scans/${encodeURIComponent(scanId)}/findings`, body `{finding: normalized}` or `{report, final:true}`. Core sets content type, `X-0sec-Scan-Id`, `x-cloud-sink-version: 1`, optional bearer authorization. Organization context serves non-scan-pathed asset writes. | `packages/core/src/cloud-sink.ts:97`, `:469`, `:489` |
| Separate final-run publisher | Non-URL/non-web-app runs also publish their final report from `run.ts`, with content type, scan ID, optional bearer authorization. This path does not add core's sink-version header. Do not accidentally send the same final report from two adapters. | `packages/cli/src/commands/run.ts:391`, `:681` |
| Delivery failure | Legacy POST errors are logged and do not override scan results. The shown helpers do not provide finite request/body limits or a durable delivery receipt; native delivery must add bounds without implying successful delivery after failure. | `packages/core/src/cloud-sink.ts:113`; `packages/cli/src/commands/run.ts:401` |

`RuntimeMode` is a legacy execution/provider mode (`api`, `claude`, `codex`,
`gemini`, `ollama`, `auto`), not the implementation language
(`packages/shared/src/types.ts:8`). Do not put `rust` or `native` into an existing
strict consumer's runtime enum merely because the producer is written in Rust.

## What is implemented, and what is missing

Implemented native foundations include owned execution/journaling, explicit
provider profiles and accounting, retained source hypotheses, plan-qualified
reproduction and candidate workflows, report rendering, hosted browser-session
login and cloud health/catalog/account/usage reads. These do not implement the
legacy HTTP-audit pipeline or its managed worker invocation.

`zero-cloud-compat` already provides generic/secure result framing, environment
gates, cumulative usage aliases, unknown-value omission, completeness checks, and
atomic local report writes (`src/lib.rs:100`, `:164`, `:225`, `:291`). Its golden
tests cover producer framing. It has no engine-to-report mapping, upload client,
managed job receiver, or scanner implementation.

Native source-review hypotheses remain unverified. Reproduction observations and
candidate validation are qualified by explicit frozen plans. These values must
not be promoted into confirmed cloud findings, or into a clean zero-findings
scan report. An absence of hypotheses is not evidence that scanning completed or
that the target is safe. Generic compatibility output must preserve this semantic
distinction, not merely match a JSON shape.

Native `Rates` are operator-supplied integer **microcurrency units per million
tokens** (`zero-protocol/src/model.rs:80`). They are not automatically USD or a
hosted catalog quote. Never label `budget.charged / 1_000_000` as `cost_usd` without
explicit currency and rate provenance. Hosted account credit/availability data
is neither an execution authorization nor a substitute for local reservations,
limits, and measured final usage. Unknown usage must stay unknown; an unresolved
reservation is not a zero charge. Aggregate unique provider-child operations,
not parent summaries plus the same children or repeated cumulative events.

## Proposed first slice: explicit operation export

Implement a read-only local exporter before HTTP delivery or worker invocation.
It accepts an existing native state path, explicit session and operation IDs,
and an explicit new output path. It verifies the operation belongs to the session,
loads hash-checked immutable attachments, and never recovers operations, starts an
engine, loads provider credentials, or issues provider/backend requests. Running
or admitted operations are rejected. Settled Unknown/failed/cancelled operations
can be exported only with their uncertainty intact.

Proposed envelope, distinct from a legacy scan report:

```json
{
  "schema": "0sec.native-operation-export/v1",
  "session_id": "session-id",
  "operation_id": "operation-id",
  "operation_kind": "source_hypothesis_review",
  "operation_status": "succeeded",
  "scope": "native_operation_only",
  "legacy_scan_compatible": false,
  "security_conclusion": "not_established",
  "artifacts": {"source.review": "sha256:..."},
  "native_outcome": {},
  "accounting": {
    "provenance": "unique-settled-provider-children",
    "operation_ids": [],
    "input_tokens": null,
    "output_tokens": null,
    "cached_input_tokens": null,
    "charged_units": null,
    "currency": null,
    "rates_digest": null,
    "usage_complete": false
  }
}
```

This is a **proposed local schema**, not an existing hosted endpoint contract.
`native_outcome` preserves the command's actual typed outcome and evidence states;
it does not remap hypotheses into `findings`. The exporter derives identity/status
fields from the journal, never from untrusted caller-supplied JSON. Accounting
provenance names and operation IDs must describe the actual derivation, not be
filled with defaults when unavailable. No `summary`, `finding_count`, `ok: true`,
or legacy `scan_completed` event is synthesized. Omit raw source bundles, tool
transcripts, credentials and arbitrary attachment contents by default; export
individual artifacts only through explicit existing artifact-export behavior.

Exporter exit 0 means the export was written, not that its underlying operation
succeeded or a vulnerability was verified. Require consumers to inspect the
operation status and evidence disposition. Preserve the existing destination on
write failure; prefer explicit no-clobber output for this new command.

## Subsequent compatibility and delivery

1. Use the pinned worker/controller source and existing acceptance fixtures in
   [the consumer audit](CLOUD-CONSUMER-AUDIT.md). Its current final-report contract
   does not accept the native-operation envelope as a completed scan report.
   Keep that envelope local and explicitly distinct until a consumer change is
   separately designed and qualified.
2. Add an explicit legacy terminal adapter only for operation/report kinds whose
   semantics can be represented honestly. Unsupported managed scan kinds fail
   with exit 2 and an explanation, never an empty successful scan. Keep generic
   and secure command classifications distinct. Preserve known accounting aliases
   and omit unknown quantities; require explicit USD provenance for dollar fields.
3. Preserve controller ownership of report recovery and retrying publication.
   A native managed workflow must write the validated legacy report atomically
   to `0SEC_REPORT_PATH`; stdout markers alone are insufficient. Do not add a
   competing final-report retry loop to the engine. Any separately authorized
   direct publication must use its own explicit mode, bounded deadlines, no
   redirects and delivery uncertainty distinct from execution outcomes.
4. Introduce an actual managed invocation only when native scope enforcement,
   authentication injection, per-host rate limits, wall-clock cancellation,
   credit/reservation handling, and scanner execution are implemented and tested.
   Parse the existing env contract fail-closed; never reuse cloud sink credentials
   as target authentication. Model output must not widen target hosts/paths or
   choose a different backend/provider/rate profile. Redirect/DNS/connection and
   credential propagation policy require concrete enforcement, not parser parity.
5. Test the real worker/controller end to end against a local target before
   advertising managed-scan compatibility. Deployment, live-account qualification,
   and scanner detection quality are separate later gates.

## Executable acceptance fixtures

- Create a native journal through an actual executable and localhost provider;
  export successful unverified review, empty review, failed, cancelled and Unknown
  outcomes. Assert exact retained identities and no fabricated findings/clean
  summary. A zero-result review must still say security is not established.
- Restart after deleting original source and disabling the provider/backend;
  export must make zero requests, leave journal bytes/ownership unchanged, reject
  foreign-session or missing operations, and verify attachment hashes.
- Use multiple provider children, duplicate command replay and repeated cumulative
  usage records. Assert no double counting; unresolved/missing usage stays unknown.
  Non-USD or unspecified currency never produces a `cost_usd` field.
- Exercise atomic/no-clobber output failure, malformed/oversized inputs and output
  backpressure. Prior reports remain intact; no partial JSON or secret data leaks.
- For the separately qualified legacy adapter, golden-test exact `0SEC_RESULT=`
  and `0SEC_EVENT_*` delimiters, newline escaping, truthiness without accidental
  trimming, generic/secure exit distinctions and partial-work error classification.
- For later delivery, use two localhost listeners: verify exact path, headers and
  `{report, final:true}` body; the redirect destination receives nothing. Exercise
  authentication rejection, rate limit, stalled body, response-size cap, cancellation
  and lost response. No retries or false delivered/not-sent assertions.
- For actual HTTP-audit migration, use local authenticated targets with allowed
  and forbidden hosts/paths, redirect escapes, concurrency/rate measurements and
  kill-switch triggers. Verify scope before effects, no credentials outside scope,
  finite cleanup, partial-result preservation and accurate cost-ceiling exit 4.

No live login, remote publication, credential inspection, or security scan was
performed to prepare this design.
