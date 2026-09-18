# Native provider transport

Initial implementation: explicit OpenAI Responses-compatible SSE endpoints.
No implicit provider selection, automatic retries, OAuth refresh, paid test calls,
Chat Completions, Anthropic Messages or cloud broker adapter yet.

The endpoint and credentials are separate from serializable request values.
HTTPS is required except explicit loopback HTTP test/local endpoints. Redirects
are rejected. Errors do not print authorization or the URL. Requests retain
custom gateway paths, explicitly cap output, and set `store:false`.

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

Existing 0sec provider tests remain the broader parity reference, especially
`packages/core/src/runtime/responses-provider.test.ts` and
`packages/core/src/runtime/llm-api.stream-retry.test.ts`.
