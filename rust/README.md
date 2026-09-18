# Native 0sec rewrite

Integration branch: `the-great-rust-rewrite`.

This is an experimental implementation, not a replacement release. Native crates
currently provide a versioned JSON protocol, SQLite session journal and budget
ledger, single-owner engine, offline Docker snapshot execution, source-preserving
finding reconciliation, explicit Docker/smolvm snapshot backends, Responses/Chat/Anthropic Messages
inference with durable accounting, a bounded offline snapshot agent, and a CLI
with an NDJSON app-server. Production scan commands, remaining provider adapters,
full agent orchestration, evolution integration and TUI
are still migration work. Unsupported legacy commands fail explicitly.

The destination is the native CLI and engine described in the
[architecture and migration plan](../docs/design/2026-09-18-native-harness-architecture.md).
The [execution design](EXECUTION-DESIGN.md) documents existing behavior and
qualification requirements. The draft protocol is not yet a compatibility promise.

From this directory:

```sh
cargo fmt --all --check
cargo test --workspace --locked
cargo run --locked -p zero-cli -- --help
cargo run --locked -p zero-cli -- schema
cargo run --locked -p zero-cli -- --state /tmp/0sec-native-example.db session create --generation baseline --budget-limit 100
```

Native state defaults to `.0sec/native/state.db`, separate from legacy state.
One engine owns a database at a time. Completed command retries return persisted
results; interrupted effects become unknown on recovery and are never silently
repeated. Explicit shutdown waits for cancellation and cleanup. Process death
still requires backend-specific external resource recovery; Rust destructors
cannot guarantee cleanup after SIGKILL.

Docker execution accepts an explicitly pinned source snapshot and an already
local image. It does not pull images or fall back to execution on the host.
An opt-in real Docker test checks isolation and cancellation; it requires a local
Node image and is skipped by the default suite. See its source for configuration.

Keep one owner for shared protocol changes and Cargo.lock. Production TypeScript
commands remain the behavioral reference during migration. Release defaults and
cloud images change only after the relevant parity gates.

Sandbox requests select Docker or smolvm explicitly; failed prerequisites never
select a different backend. Both use verified private snapshot staging and the
same durable operation, cancellation and retry semantics. The smolvm profile
requires Linux/KVM, the qualified runtime, and a prepared local archive. Guest
output is buffered until completion. Its opt-in engine integration test exercises
a real two-turn agent using a loopback provider fixture, not paid inference.

App-server clients receive an `admitted` event with operation/session/command and
execution IDs once a new effect has durable ownership. Wait for this event before
cancelling an asynchronously submitted command. It is not proof that a process or
provider request has started. Cancellation known to precede provider dispatch
releases the reservation at zero charge; uncertain remote outcomes retain it.

Agent requests may set `continuation_of` to a completed agent operation ID in the
same session. The engine restores the last persisted provider input and complete
replay, including previous tool results, before appending the new prompt. It
requires the same model, provider route/rates, instructions and pinned execution
profile. Omitting the field starts a fresh history; selecting an earlier completed
operation explicitly branches. Unknown/interrupted operations cannot be continued
through this path, and no prior effect is reissued. History is reconstructed from already durable records rather than duplicated.
Journal schema v3 adds optional activation epochs for generation-bound sessions;
v1/v2 sessions migrate without inventing an activation pin. Host operation details
retain pre-dispatch recovery identities and post-settlement lease release evidence.

Journal schema v4 retains immutable source/plan/evidence artifacts with owner-bound
operation attachments. Attachment bytes and the hash-only event commit atomically;
ordinary event streams do not expose source bytes. Reads recheck content identity.

The native CI workflow tests the declared minimum Rust 1.85.0 and stable on Linux,
builds the experimental executable, and checks formatting/production lints. The
lockfile pins `yoke-derive` 0.8.2: 0.8.3 uses `str::from_utf8`, which failed an
actual 1.85.0 build despite dependency metadata allowing its selection. Preserve
this pin until the minimum-toolchain job demonstrates an upgrade works. Default
CI uses deterministic subprocess/loopback fixtures; opt-in Docker/smolvm tests
still require separately prepared local runtimes and images. CI does not publish
or replace the production TypeScript CLI.

Hosted inference can use the native login credentials and an explicit catalog
model, without a provider JSON file:

```sh
0sec-native --hosted-model MODEL_ID infer --session SESSION_ID \
  --command-id inference-one --provider hosted --reservation 100000 \
  --request request.json
```

The request's `model` must equal `MODEL_ID`. `--hosted-host` selects a gateway;
`--hosted-token-env` selects a credential environment variable. Defaults reuse
`0SEC_CLOUD_TOKEN` or the private native login file. `--hosted-timeout-ms` sets the
inference deadline (default 300000 ms). Catalog discovery has a separate 30-second
limit. The gateway receives its public model ID, never the catalog's upstream
model name. The catalog selects Responses or Chat Completions transport.

Hosted budgets and charges use integer micro-USD. If you mix hosted and manual
profiles in a session, supply the manual rates in the same units. Catalog USD-per-million prices
must convert exactly to integer micro-USD-per-million; fractional micro-USD and
overflow fail before inference. Each operation retains a credential-free selected
model quote, normalized digest, route, limits and rates. Captured quote prices use
canonical decimal strings to survive JSON journals without rounding; catalog
listing preserves the gateway's numeric decimal lexemes. This is a reproducible
price identity, not proof of the gateway's final bill. A changed quote conflicts
with an existing command ID instead of dispatching it again. Exact retries still
fetch metadata, but do not repeat inference. An incomplete dispatched stream
remains unknown and holds its reservation pending explicit reconciliation.

The selected model and maximum output are enforced before dispatch. Direct
`infer` accepts a lower requested maximum; agent and source-review currently
request 8192 tokens and reject catalog models with a smaller output limit.
Hosted profiles can coexist with manually configured profiles under other names;
`hosted` must not also be defined in the provider file. No live hosted request is
part of the default test suite.


The line console durably acknowledges accepted follow-up prompts while a turn is
running. Successful turns drain those inputs in FIFO order; interruption or an
uncertain outcome leaves pending inputs for explicit resumption. Inspect them
with `queue list --session SESSION_ID`, then use `queue run --session SESSION_ID
--input INPUT_ID` or `queue cancel --session SESSION_ID --input INPUT_ID`.
`queue enqueue --session SESSION_ID --command-id INPUT_COMMAND --request
agent.json [--after-input INPUT_ID]` accepts a request without starting it. Use the
existing app-server connection for enqueueing while another engine owns the
state file. See [durable input semantics](crates/zero-engine/QUEUE.md).

Agent requests can opt into an explicit context projection policy:

```json
"context_policy": {
  "schema_version": 1,
  "max_input_bytes": 32768,
  "keep_recent_rounds": 2
}
```

The engine preserves instructions, tool definitions, every user prompt, and the
newest complete assistant/tool rounds. It may omit older complete rounds from a
provider request to meet the configured serialized-input byte bound. Full inputs
and a deterministic receipt remain retained; old operation records are untouched.
Opaque reasoning and signed thinking stay paired with their complete tool rounds.
The same policy must remain in place across continuation and queued follow-ups.
If required context cannot fit, the engine stops before another provider call.

This is an explicit lossy projection, not a semantic summary or a tokenizer.
`max_input_bytes` does not include instructions/tool schemas/wire overhead and is
not a model token-window guarantee. Full retained context is separately bounded
at 8 MiB and 10,000 items; existing per-operation artifact quotas still apply.
Restoration checks original journals with a 64 MiB cumulative validation budget.
Omitting the field keeps existing full-context behavior and serialized identities.
Separately accounted summaries, journal retrieval and tokenizer-aware scheduling
remain migration work.

Source-enabled agent requests offer `search_source_text` over the explicitly
pinned source. Its optional `mode: "regex"` enables bounded per-line regex search;
`case_sensitive: false` enables Unicode case-insensitive matching in either mode.
The default remains case-sensitive literal search. Results preserve exact source
lines and hash citations, including their original line endings. See the
[source library documentation](crates/zero-source/README.md) for pattern syntax,
resource bounds and truncation semantics.

Native source hypotheses support operator triage, independently of verification:

```sh
0sec-native findings reviews --session SESSION
0sec-native findings list --session SESSION --operation SOURCE_OPERATION
0sec-native findings show --session SESSION --operation SOURCE_OPERATION --hypothesis HYPOTHESIS
0sec-native findings accept --session SESSION --operation SOURCE_OPERATION --hypothesis HYPOTHESIS --command-id DECISION_ID --expected-revision 0 --note 'Investigate further'
```

Use `suppress` or `reopen` with the same target flags and the current revision to
change operator triage. Each successful new decision advances the revision and
retains its note. `show --after-revision N --limit 50` pages immutable history.
`list --offset N --limit 32` pages the immutable review order; advance the offset
by the number returned until an empty page. Pages are also byte-bounded.
Reuse the same command ID and arguments after uncertain delivery: the reply
contains the original decision, current finding state and `duplicate: true`.
Decision command IDs are unique within the session's triage namespace, separate
from execution command IDs. A changed retry or stale revision fails explicitly.
List/show read existing current-schema native state without migration, engine
ownership or provider configuration. Mutations use the native engine journal;
acceptance and suppression never alter source evidence or verification status.
This does not read legacy finding databases or infer fingerprint families.

The app-server emits optional live `model_progress` events for direct inference,
agent turns (including queued turns), and dedicated source review. Each event
identifies the session, paid inference operation, optional parent operation, and
an operation-local sequence. Payloads contain text, exposed reasoning/refusal, or
provisional tool metadata/argument fragments. They contain no opaque signatures,
encrypted replay or raw provider errors; generated text can still contain source
or user data and is not generally redacted.

Progress is best-effort display data. Sequence gaps indicate dropped deliveries;
per-inference caps can also suppress later updates. Clients must tolerate missing
or late progress and discard it after the terminal result for that operation or
parent. Only final journaled completions authorize tool execution and determine
usage. Retries return stored results without replaying progress. The app-server
uses a separate bounded progress queue and prioritizes command replies and
operational events. Full/closed progress queues never cancel inference; ordinary
transport-disconnect and output-deadline behavior still applies.

Progress and operational events use independent queues, so progress may precede
its admission notification. Correlate by session/operation IDs rather than
assuming admission-first delivery.

The experimental `tui` frontend adds full-screen session selection, conversation
and durable queue views over an owned app-server connection. It consumes bounded
display history and live progress without opening the database. Saved pending
inputs require explicit resumption. See the [CLI guide](crates/zero-cli/README.md#experimental-full-screen-terminal)
for controls and shutdown behavior. Its findings view adds native source-review
discovery and explicit operator triage; acceptance leaves hypotheses unverified.
Approval/question dialogs, legacy finding families and full terminal parity remain open.


Native agent requests can opt into bounded joined subagents through
`delegation_policy`: host-defined roles choose provider/model, curated tools,
turn/reservation limits, `max_parallel` (1–4) and `max_children` (1–16 per root
operation). The model's `delegate_tasks` tool accepts only named roles and task
prompts. Children share the session budget and pinned execution authority, cannot
nest delegation or submit findings, and are all joined before the parent settles.
Results are ordered untrusted data with durable child receipts. Cancellation
waits for child cleanup; uncertain work retains its budget holds. See the
[migration record](MIGRATION.md#bounded-joined-subagents) for continuation and
remaining workflow boundaries.


Active agents accept explicit durable steering at model-round boundaries. In the
TUI conversation, Ctrl-T sends the composer to the admitted active root; Enter
still queues a follow-up. In the line console, `/steer TEXT` addresses the active
turn and `//steer TEXT` queues literal `/steer TEXT`. App-server clients can address
an exact running root or dispatched child with `SteerAgent`. `steer list` reads
retained status without owning the engine or loading provider configuration.

A saved message is Pending until its exact text is Captured in a journaled model
request. Captured does not prove provider receipt. Messages left when the target
stops are Undelivered and never automatically run in another turn. Steering
preserves the target's tools, provider, source scope, resource and turn limits.
See [durable input semantics](crates/zero-engine/QUEUE.md#steering-an-active-agent).


Interactive request profiles can explicitly enable `"operator_questions": true`.
The model may then call `ask_operator` with bounded choices or custom-text
questions. Operator answers and dismissals are durable, informational tool
results; they never grant tools, widen source scope, change a provider, or approve
an execution. Only explicitly selected delegated roles receive this tool.
A cancelled or interrupted question remains inspectable and never automatically
restarts its actor. See the [migration record](MIGRATION.md#durable-operator-questions)
for receipt and continuation guarantees.

The optional `tool_approval_policy: {"require_approval":["execute_snapshot"]}`
requires an explicit operator decision for each matching invocation. Gated Docker
profiles use immutable image references. Approval is separate from informational
questions and from actual execution status. The CLI exposes read-only
`approvals list/show`; `show --full-intent` includes the complete retained intent.
Console/TUI permission controls address a specific invocation and digest; they
cannot widen the captured profile. See `MIGRATION.md` for remaining scope and
autonomy-mode parity requirements.
