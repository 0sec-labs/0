# Native provider transport

Implemented wires: explicit Responses, Chat Completions and Anthropic Messages
SSE endpoints. No implicit provider selection, automatic retries, OAuth refresh,
paid test calls or cloud broker adapter.

The endpoint and credentials are separate from serializable request values.
HTTPS is required except explicit loopback HTTP test/local endpoints. Redirects
are rejected. Errors do not print authorization or the URL. Requests retain
custom gateway paths and explicitly cap output. Responses requests set
`store:false`; each other wire uses its own request fields.

Stream framing tolerates arbitrary network chunks, CRLF and multiline data with
bounded frames and total bytes. Provisional argument fragments cannot produce
executable calls. Only a completed response with valid object arguments produces
tool-call data; the engine must still validate tool authorization and schema.
Opaque reasoning items are retained for replay. EOF without completion is an
incomplete result, not success. Partial reported usage is retained; missing usage
is unknown rather than free. Cancellation cannot prove remote billing stopped.

Prices are operator-supplied integer microcurrency units per million tokens;
no current price assumptions are embedded. Cached inputs are a subset of total
inputs. Native inference reserves budget before dispatch; incomplete/unknown
billing retains the reservation. This is durable accounting, not a guarantee
against a provider exceeding the requested or reserved amount.

Contract references checked 2026-09-18 using the OpenAI Docs skill:

- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Stateless reasoning replay](https://developers.openai.com/api/docs/guides/reasoning)

Existing 0sec provider tests remain the broader parity reference, especially
`packages/core/src/runtime/responses-provider.test.ts` and
`packages/core/src/runtime/llm-api.stream-retry.test.ts`.

## Explicit Chat Completions routes

Select `wire_api: "chat_completions"` in the native provider profile. Responses
remains the default; endpoint URLs are never guessed or rewritten. This adapter
supports text messages and function tools with `max_completion_tokens` and
`stream_options.include_usage`. It rejects unsupported multimodal input and
cross-wire reasoning instead of silently flattening it.

Chat replay carries a model-bound assistant-message envelope. Tool IDs,
`reasoning_content` and one complete `reasoning_details` array survive the next
turn. Ambiguous incremental reasoning-details formats fail explicitly. A usable
completion requires a consistent finish reason and `[DONE]`; final accounting
requires the trailing empty-choices usage frame. Stream errors do not expose
provider error bodies. No retry or provider fallback is automatic.


## Explicit Anthropic Messages routes

Select `wire_api: "anthropic_messages"`. The exact endpoint URL is retained;
API keys use `x-api-key` and `anthropic-version: 2023-06-01`, without a Bearer
header. System instructions, text messages, function definitions/results and
output bounds map explicitly to Messages fields. All tool results must match
outstanding calls once, in the immediate following user turn. Unsupported media,
server tools, citations, assistant prefilling, foreign-wire replay and mismatched
model replay are rejected instead of being silently dropped or reinterpreted.

Ordered thinking text, signature fragments, redacted thinking and complete tool
JSON are retained in a model-bound `anthropic_message` envelope. Replaying it
sends the entire original assistant content array, without adding cache controls
or reconstructing it from visible text. Thinking is opaque replay data, not a
visible answer or permission to run a tool. This adapter does not request a
thinking mode or infer one from a model name. The common request schema has no
thinking/beta/cache-control options yet.

A consistent stop reason, closed valid content blocks and `message_stop` are
required before tool content becomes usable. Missing/truncated terminal events,
invalid JSON, unsupported deltas or unknown event types fail closed. Stream error
bodies are not retained because they may contain credentials or gateway details.
Incomplete replay envelopes preserve diagnostic blocks and argument fragments
but are rejected for subsequent execution requests. No retry is automatic.

Anthropic's input count excludes cache reads/writes. Normalized input adds these
counts, and cached input is the cache-read subset. Raw usage remains in replay.
Only terminal usage with supported billing dimensions is final for the engine:
nonzero cache-write/server-tool counters, nonstandard tiers/geographies or unknown
billing dimensions retain the budget reservation for explicit reconciliation.
Current Rates has no cache-write or server-tool price dimension. Ordinary standard
tier/global metadata, zero tool/cache-write breakdowns, and thinking-token subsets
are accepted without inventing additional charges. Missing total counters remain
unknown. This conservatism is not a claim that a completed model turn was free.

Official references checked 2026-09-18:

- [Messages schema and signed block replay](https://platform.claude.com/docs/en/api/messages/create)
- [Streaming event sequence and deltas](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Cache token accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

The existing `packages/core/src/runtime/llm-api.ts` positive Anthropic wire branch
is the migration reference for headers, ordered retained reasoning and tool result
mapping. Unlike its retry helpers, native transport never retries implicitly.
Unit and loopback fixtures cover exact paths/auth, fragmented streams, signed
replay, tool pairing, cancellation, errors, bounds and provisional/final usage.
No live provider call or broader Anthropic feature parity is claimed.

## Advisory live progress

`complete_with_progress(request, cancel, callback)` adds synchronous normalized
progress; `complete` retains its previous behavior without an observer. The
callback accepts `ProviderProgress` and must be nonblocking and nonpanicking;
a bounded channel's `try_send` is appropriate. Do not perform storage, blocking
IO, or waits inside the callback, because it runs on the transport task.

The authoritative parser first accepts each complete SSE frame. An independent
allowlist then emits text, refusal, exposed reasoning/summary text, and provisional
tool ID/name/argument fragments. Responses positions use output/content indices;
Chat text uses 0/0 and tools their call index; Anthropic uses content-block indices.
Repeated invariant Chat tool metadata is emitted once, while argument fragments
retain interleaving. These fragments may be incomplete JSON and never authorize
execution. Existing Chat metadata validation remains unchanged.

Encrypted reasoning, Anthropic signatures and redacted blocks, Chat opaque
`reasoning_details`, raw SSE objects, provider error bodies, credentials and usage
are not progress fields. They are not inferred or reconstructed from opaque data.
The existing replay/accounting paths retain their own required evidence. A
terminal-only response produces no fabricated live deltas, avoiding duplicate
rendering of the final receipt.

Each event carries at most 16 KiB of raw UTF-8 fragments, split only at character
boundaries. Per inference, at most 4096 events and 4 MiB of fragment bytes are
emitted; further progress is suppressed while authoritative parsing continues.
Progress indices are bounded to 256 positions, and empty fragments are skipped.
Malformed or unsupported advisory fields are ignored without changing completion
classification. Progress is best-effort display data: consumer queues may drop
it, and it is neither a durable cursor nor final usage. Only the returned
`Completion`, with the existing terminal/status/usage checks, supplies the final
result and tool authority. There are still no implicit retries.

Loopback tests cover all three wire formats, progress before terminal release,
interleaved tool arguments, fragmented UTF-8 SSE, opaque-field exclusion,
cancellation/malformed streams, fragment and aggregate bounds, and exact final
completion equality with observers enabled or disabled. No paid calls are used.
