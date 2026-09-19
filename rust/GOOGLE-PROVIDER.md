# Native Gemini provider

The native CLI supports the Gemini `streamGenerateContent` API with explicit
host configuration. This is the native equivalent of the Google wire path in
`packages/core/src/runtime/llm-api.ts`. It does not invoke a provider CLI, discover
credentials, wrap Google Code Assist, or use Vertex OAuth.

```json
{
  "gemini": {
    "url": "https://generativelanguage.googleapis.com/v1beta/models/MODEL_ID:streamGenerateContent",
    "wire_api": "google_generate_content",
    "api_key_env": "GEMINI_API_KEY",
    "rates": { "input": 0, "cached_input": 0, "output": 0 },
    "timeout_ms": 60000,
    "max_response_bytes": 8388608
  }
}
```

Replace `MODEL_ID` with the exact requested model, and supply the operator's
actual rates in integer microcurrency units per million tokens. The zero values
above are placeholders, not a pricing quote. Use this file through the existing
`--providers` option with `infer` or an actor request. The URL must match that
request's model. Gateway prefixes are preserved. HTTPS and explicit loopback
HTTP fixtures are supported; arbitrary URL queries, embedded credentials,
redirects and retries are rejected. Transport adds only `alt=sse`; credentials
use `x-goog-api-key`, never a query or Authorization header.

Text and function declarations use the native Google wire. Only Rust's existing
tool dispatcher can act on returned function calls. No server search, URL
retrieval, code execution, media or extension tools are enabled. Completed
assistant parts, including `thoughtSignature`, are retained in order as
model-bound `google_content` replay. Synthesized local call IDs correlate tool
results when Google omits IDs; they do not modify signed upstream calls. Other
providers' replay, incomplete Google replay and malformed/mismatched results
are rejected. Context projection retains or omits complete rounds, including
opaque parts and all matching tool results.

One candidate is requested and accepted. Streaming text/thought text is advisory;
signatures are never emitted as progress. Function calls become usable only in
a completed response. Truncation, malformed frames, unsupported parts, duplicate
terminal responses and partial frame tails cannot become a completed tool turn.
An original absolute deadline and cancellation token cover the entire request;
there is no automatic retry. Exact command retry uses the existing retained
operation and does not perform new inference.

Final usage requires explicit prompt, candidate and total token counts. Output
is candidates plus thoughts, added once; cached input is a subset of prompt
input. Totals and unsigned arithmetic are checked. Unsupported billing dimensions
(including non-text modalities, nonstandard service tiers and server-tool prompt
usage) do not receive final accounting. Missing/incomplete usage retains the
original reservation for reconciliation; it is never converted to zero cost.
Known final failure or output-limit usage is retained as evidence; the current
Engine conservatively keeps its reservation until reconciliation for every
non-completed response. Rates remain host estimates, not a provider invoice. Hosted catalog
configuration currently supports only its existing Responses/Chat routes and
rejects Gemini pins. Private-cloud managed grant schemas and host authorization
policy require their own coordinated rollout before managed Google dispatch;
this checkpoint qualifies explicit native BYOK routes only.

Tests use deterministic local HTTP fixtures: split UTF-8/SSE, signed parallel
calls, cross-model/forged replay rejection, thinking/cache accounting, malformed
usage, truncation, cancellation, deadline, CLI accounting, context-enabled actor
continuation and offline command retry. No paid provider or live model is part
of this qualification.

Primary wire references: [GenerateContent and UsageMetadata](https://ai.google.dev/api/generate-content),
[thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures).

## Process-provider boundary

The legacy `runtime/cli-native.ts` supports Claude subscription inference through
an external CLI. Its tool execution and session behavior cannot be copied into
the Rust provider contract: the external CLI may execute configured hooks or its
own tools before Rust authorizes an effect.

The documented [hook disabling rules](https://code.claude.com/docs/en/hooks)
state that local `disableAllHooks` settings cannot disable managed hooks.
[Safe mode](https://code.claude.com/docs/en/cli-reference) still permits managed
hooks; organization settings may arrive from the account rather than a local
file. [Bare mode](https://code.claude.com/docs/en/headless) skips autodiscovery but
does not use subscription OAuth. Therefore a pinned executable, empty working
directory and CLI flags alone do not establish Rust-only effect authority for
subscription execution. No such process adapter or arbitrary shell fallback is
implemented. A future route needs a separately verified isolation/egress and
credential design; this limitation does not apply to the native HTTP adapter.
