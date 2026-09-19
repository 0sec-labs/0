# Native Ollama provider

The native CLI supports Ollama's `/api/chat` text and function-call wire through
an explicit host profile. This ports the route in
`packages/core/src/runtime/ollama.ts`; it preserves native assistant thinking and
calls for continuation instead of flattening them into text.

```json
{
  "local": {
    "url": "http://127.0.0.1:11434/api/chat",
    "wire_api": "ollama_chat",
    "rates": { "input": 0, "cached_input": 0, "output": 0 },
    "timeout_ms": 60000,
    "max_response_bytes": 8388608
  }
}
```

Use the file with the existing `--providers` option and select `local` plus the
exact installed model name in an inference or actor request. Set accounting
rates explicitly in integer microcurrency per million tokens; zero rates are an
operator choice, not a claim that running a local model consumes no resources.
Omitting credentials is allowed only for explicit `ollama_chat` profiles using
wire-default authentication. An optional `api_key_env` supplies a Bearer token
for a compatible gateway; no credentials are discovered automatically. Existing
HTTPS/loopback HTTP endpoint restrictions apply. The exact endpoint must end in
`/api/chat`; prefixes are retained. The CLI does not start Ollama, pull models,
rewrite model names, follow redirects, or automatically retry HTTP requests.

Requests send native `messages`, function `tools`, `stream: true`, and
`options.num_predict`. Text, thinking, and complete tool-call arguments are
accepted from bounded NDJSON. Thinking appears only in retained native replay
and advisory reasoning progress, not the final visible answer. The parser caps
lines at 1 MiB, calls at 256, and total response bytes at the configured limit.
Multimodal messages and fragmented JSON argument strings are unsupported.
Legacy complete JSON argument strings are accepted only if they decode to an
object; malformed strings never become executable arguments.

Only one terminal `done: true` frame with `done_reason: "stop"` and explicit
unsigned `prompt_eval_count` and `eval_count` can authorize a completed result.
Optional `prompt_eval_cached_count` is a subset of input; output already includes
thinking and is counted once. Missing usage, truncation, trailing frames, invalid
arguments, cancellation, and deadline expiry retain an incomplete result and
cannot dispatch tools. The Engine conservatively retains reservations for
incomplete results, even when partial usage is available. Rates are host
accounting estimates, not server invoices.

Ollama's tool results correlate by `tool_name`, with no upstream call ID. Native
replay stores deterministic local IDs derived from the exact request and call
position, enforces unique IDs and ordered complete results, and sends the actual
assistant message back to Ollama. A later round gets a different ID even when it
asks for the same function again. Context projection retains or omits whole
rounds. Exact command retries use retained operations and perform no new model
request. Provider output never bypasses the existing Rust tool dispatcher or
original session/budget/cancellation authority.

Hosted cloud catalogs still support their existing Responses/Chat routes only;
this slice does not add managed Ollama routing. Authentication and subprocess
migration gaps are recorded in [the parity audit](PROVIDER-PARITY-AUDIT.md).

Qualification uses local HTTP fixtures, including native agent continuation,
unknown-tool rejection, missing-usage holds with no execution admission, offline
exact retry, cancellation, split UTF-8, ordered calls and malformed terminal
frames. No live model, model download, or paid inference is part of these tests.

```sh
cargo +1.85 test --manifest-path rust/Cargo.toml --locked -p zero-provider
cargo +1.85 test --manifest-path rust/Cargo.toml --locked -p zero-cli --test ollama --test inference --test google --test usage_authority
cargo +1.85 test --manifest-path rust/Cargo.toml --locked -p zero-context -p zero-protocol -p zero-cloud-client
cargo +1.85 test --manifest-path rust/Cargo.toml --locked -p zero-cli --bin 0sec-native providers::tests
cargo +1.85 check --manifest-path rust/Cargo.toml --locked --workspace --all-targets
```

Primary wire references: [chat API](https://docs.ollama.com/api/chat),
[tool calling](https://docs.ollama.com/capabilities/tool-calling).
