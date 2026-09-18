# Native application adapter

`0sec-native` is the experimental session/execution CLI. It does not implement
the legacy security commands or silently invoke the TypeScript CLI.

```sh
0sec-native --help
0sec-native schema
0sec-native snapshot pin /path/to/source
0sec-native --state /tmp/zero-native.db session create --generation builtin --budget-limit 1000
0sec-native --state /tmp/zero-native.db session list
0sec-native --state /tmp/zero-native.db session show SESSION_ID
0sec-native --state /tmp/zero-native.db session budget SESSION_ID
0sec-native --state /tmp/zero-native.db session events SESSION_ID --after 0 --limit 100
0sec-native --state /tmp/zero-native.db exec --session SESSION_ID --command-id COMMAND_ID --request request.json
0sec-native --state /tmp/zero-native.db app-server
```

The default state path is `.0sec/native/state.db`, relative to the working
directory. It is separate from the legacy database. `--docker-bin` explicitly
selects the Docker executable; requests cannot override that host setting.
Execution JSON must satisfy the generated protocol schema, including its pinned
source snapshot. The executor resolves a local image; this command does not pull
images or provision Docker.

`snapshot pin` prints a `SnapshotPin` for the execution request's `snapshot`
field and does not create a database. It records current file identities;
execution rejects subsequently changed source. Write the manifest outside the
source directory so the manifest itself does not change the indexed tree.
`session budget` reads persisted integer microcurrency units for inference reservations and charges.

App-server uses one JSON request per line and reserves stdout for JSON responses
and execution events. Initialize each connection first:

```json
{"protocol_version":1,"id":"hello","command":{"method":"initialize"}}
{"protocol_version":1,"id":"sessions","command":{"method":"session_list"}}
```

Responses echo the request `id`; operation `command_id` supplies persistent
deduplication independently of transport correlation. Executions and inference run concurrently
so cancellation requests can be accepted while work is active. There are at most
64 outstanding execution or inference responses per connection. Initialization, session
commands and cancellation are handled in input order. Execution completion order
is not request order. Malformed or oversized records yield errors and the next
record remains usable. EOF, SIGINT and SIGTERM initiate engine shutdown and
drain execution cleanup before exit.

One-shot commands print a final JSON reply. Engine errors and non-successful
execution outcomes use nonzero exit status. Schema/help/version do not open the
database. Tests launch the built executable and cover this wire behavior and
cross-process session persistence without provider requests.

## Explicit provider inference

Supply a profile file using `--providers providers.json`. All fields are required;
there are no default models, prices or credentials. Rate values are integer
microcurrency units per million tokens. Limits apply to the entire response.

```json
{"work":{"url":"https://api.openai.com/v1/responses","api_key_env":"OPENAI_API_KEY","rates":{"input":1000000,"cached_input":500000,"output":2000000},"timeout_ms":60000,"max_response_bytes":8388608}}
```

Those rates are illustrative, not current provider pricing. Set the named secret
in the process environment. Configuration and request files are bounded to the
protocol frame limit. Credentials remain in memory and are never persisted as
part of requests. Schema/help/version skip provider files and credential access.

```json
{"model":"YOUR_MODEL","instructions":"Answer briefly","input":[{"role":"user","content":"Hello"}],"tools":[],"max_output_tokens":128}
```

```sh
0sec-native --providers providers.json infer --session SESSION_ID --command-id UNIQUE_ID --provider work --reservation 100 --request inference.json
0sec-native --providers providers.json app-server
```

Reservation and session budget use the same integer units. Reusing the same
command ID with the same request returns the persisted outcome without another
provider call. Changed payloads conflict. Incomplete or failed outcomes exit
nonzero; unknown usage does not become a zero charge. The app-server `infer`
method uses the same fields; `cancel.execution_id` is the inference command ID.
No OAuth or implicit provider routing is implemented.

## Experimental bounded agent

```sh
0sec-native --providers providers.json agent --session SESSION_ID --command-id UNIQUE_ID --request agent.json
```

The request fields are `provider`, `model`, `instructions`, `prompt`,
`max_turns`, `reservation_per_turn`, and `execution` (a complete execution
request with a pinned snapshot; see `schema` and `snapshot pin`). All limits and
provider selection are explicit. The model may request the offered execution
tool's argv; the operator supplies image, snapshot, network policy and resource
limits. Tools run in an offline disposable container from that pinned snapshot.
This is an experimental model/tool loop, not production security scan parity.
Its text is a model assessment, not independently verified security evidence.

App-server `run_agent` runs concurrently with other requests; cancellation uses
the parent agent command ID as `execution_id`. Unknown provider usage after
cancellation keeps the operation/accounting unresolved and the reservation
held. One-shot agent exit is successful only for a succeeded parent operation.
The subprocess tests use a localhost fixture for a no-tool completion and a
cancelled provider stream; they make no external provider calls.

## Native prerequisite diagnostics

`0sec-native doctor` prints JSON with native platform/build, provider profile and
credential-presence validation, Docker client/selected context/server probes,
smolvm 1.14.6 version, non-root Linux and KVM read/write access. Use global
`--providers` and `--docker-bin`, and doctor options `--smolvm-bin` and
`--timeout-ms` (10–30000, default 2000 per concurrent executable probe).
Raw executable output, provider URLs, profile names and credential values are
never printed. Provider checks make no network calls; Docker server availability
uses the operator's selected Docker context and can contact that daemon.

The state check creates/removes a private temporary file in the nearest existing
parent, without creating state directories or opening/migrating the database.
It assesses current writability, not future race-free access or database health.
KVM access does not prove working virtualization. Smolvm's version check does
not verify the qualified archive digest, images, kernel, rootfs or guest boot.
No tools are installed, no images pulled and no resources provisioned.

Exit 1 means an invalid requested provider configuration, unwritable state
location, or unavailable explicitly selected Docker executable/context/server.
Missing optional default backends are reported as unavailable but do not make
an inference-only installation fail. Exit 0 is prerequisite status, not proof of
valid provider credentials or a working security scan. Argument/setup errors
exit 2. Legacy Node/Bun/TUI and external Claude/Codex/Gemini CLI checks are not
implemented: those are not requirements of the current native engine. Legacy
`doctor` had no flags requiring compatibility. Help/schema still bypass config.

## Operator usage reconciliation

```sh
0sec-native session reconcile-usage SESSION_ID --operation OPERATION_ID --charged 3 --evidence 'Operator reviewed provider receipt reference'
```

Use this only after independently checking billing for an unresolved request.
The charge is an operator-reported integer in the session's accounting units;
the evidence string is recorded atomically with the charge, not cryptographically
verified. The engine requires an idle session and a settled matching operation.
Successful reconciliation returns the updated session budget and releases its
held reservation. It leaves the operation Unknown and does not retry the provider
request or convert its missing output into a successful result. An exact command
retry still returns the original unresolved outcome. Engine rejection exits 1;
missing or invalid CLI arguments exit 2.

Provider profiles may explicitly set `"wire_api":"chat_completions"` for a Chat
Completions streaming endpoint, or `"wire_api":"responses"` for Responses.
Omitting it preserves the Responses default. The URL is used exactly as supplied;
no path rewriting, API guessing, or automatic fallback occurs. For example, a
Chat profile uses `"url":"https://YOUR_PROVIDER/v1/chat/completions"` alongside
`"wire_api":"chat_completions"` and the same explicit credential/rates/limits.
The CLI request remains the native request schema; the selected codec converts
it into the appropriate wire shape and requests streamed usage. Both `infer`
and `agent` honor the profile's wire choice. Localhost tests cover Chat usage
settlement, exact retries, and a two-turn rejected-tool/reasoning replay without
running any container tools.

## Explicit shared sandbox backend

```sh
0sec-native --docker-bin /path/to/docker --smolvm-bin /path/to/smolvm sandbox --session SESSION_ID --command-id UNIQUE_ID --request sandbox.json
```

`sandbox` accepts the shared `SandboxRequest` schema: the snapshot/program/limits
fields match `exec`, but `backend` replaces the top-level Docker `image` field.
Use `"backend":{"type":"docker","image":"local:image"}` or
`"backend":{"type":"smolvm","image_archive":"/absolute/local/image.tar","archive_digest":"sha256:...","storage_gb":1}`.
Smolvm requires integer CPUs and qualified local prerequisites. Missing smolvm,
KVM, archive or digest qualification fails without falling back to Docker.
The command uses the configured backend for disposable execution; it does not
pull images, install runtimes or provision host prerequisites.

`--smolvm-bin` is now global and also remains accepted after `doctor`.
App-server `run_sandbox` executes concurrently and supports cancellation; its
one-shot exit succeeds only when the durable parent operation succeeds.
Agent request `execution` accepts either the existing legacy Docker object or
the explicit shared sandbox object above. These local adapters do not establish
production security-scan parity or hosted-cloud execution support.

Agent JSON may include `"continuation_of":"PRIOR_AGENT_OPERATION_ID"` with a new
command ID and follow-up `prompt`. This reconstructs the completed parent's last
provider input and final replay from durable records, including its final answer;
it never reissues prior provider or tool calls. Each continuation can run in a
new executable process. Keep the same session, provider/model, instructions,
rates, wire API, endpoint and pinned execution profile. Unknown or incomplete
parents are rejected. Omitting the field starts fresh; reusing a command ID with
an identical request returns its recorded outcome rather than adding a turn.
This is continuation of completed conversations, not automatic recovery of
interrupted operations.

## Experimental line console

```sh
0sec-native --providers providers.json console --session SESSION_ID --request agent-profile.json
```

The profile is an explicit `AgentRequest`. Its `prompt` field is overridden by
each nonblank UTF-8 stdin line; the profile prompt is never submitted on startup.
Each line is one serial turn with a fresh command ID. All provider, instruction
and sandbox authority remains fixed. Optional `continuation_of` selects the
initial completed checkpoint; subsequent successful turns continue from their
returned operation IDs. Prompts are bounded by the protocol frame byte limit.

Stdout contains answer text only. Stderr contains command IDs, durable admission
IDs and completed checkpoint IDs. EOF between turns exits successfully; a final
line without newline is accepted. Ctrl-C/SIGTERM during work waits for engine
cancellation/cleanup and exits nonzero. Failed, cancelled or Unknown turns stop
without submitting queued prompts; inspect the printed operation ID in session
events/budget and reconcile unknown usage explicitly. This is a scripted line
console foundation, not full-screen TUI parity or recovery of interrupted work.

## Read-only hosted metadata

```sh
0sec-native hosted health
0sec-native hosted --host https://cloud.0.security --token-env MY_HOSTED_TOKEN models
0sec-native hosted account
0sec-native hosted usage
```

The nonempty trimmed token named by `--token-env` (default `0SEC_CLOUD_TOKEN`)
wins. With an environment token, the host is `--host`, then `0SEC_CLOUD_HOST`,
then `https://cloud.0.security`. If the default token variable is absent or empty,
read `~/.0sec/cloud.env`; its token is paired with its file host (or the canonical
host when omitted), ignoring an unrelated environment host. `--host` always
overrides the selected source. A custom `--token-env` never falls back to the
default credential file. No login credentials are written. These commands bypass the native state database,
Docker, and provider profile configuration entirely; help/schema read no tokens.

Successful responses are JSON on stdout. HTTP/network/timeout/cancellation errors
produce sanitized stderr and exit 1; missing token or invalid configuration
exits 2. Requests have a fixed 30-second deadline and 1 MiB response limit.
SIGINT/SIGTERM cancels a live request. Redirects/retries are disabled and HTTPS is
required except loopback HTTP. This surface only reads health, model catalog,
credit balance and request usage; it neither starts hosted inference nor uploads
scans. Account percentages remain service-reported, never reconstructed locally.

## Explicit pinned plugin calls

```sh
0sec-native --harness-config /trusted/host.json session create-pinned --budget-limit 100
0sec-native --harness-config /trusted/host.json plugin-call --session SESSION_ID --command-id UNIQUE_ID --plugin fixture --tool inspect --input input.json
```

The host configuration is selected explicitly, never discovered from a project
or supplied by plugin RPC. It is bounded JSON with unknown fields rejected:

```json
{"registry":"/absolute/existing/registry.db","engine_artifact":"sha256:EXPECTED_ENGINE_ARTIFACT_DIGEST","plugins":{"fixture":{"enabled":true,"trusted":false,"grants":["compute"]}},"launch":{"backend":{"type":"docker","image":"local:plugin-runtime"},"interpreter":["node"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":8192}}
```

Replace the example digest with the actual pinned artifact identity. The registry
must already contain a verified active generation; this CLI installs or activates
none. Expected engine artifact and serialized host policy must match the active
generation. `trusted` is provenance metadata and does not grant capabilities.
Launch backend, interpreter and resources are host authority; plugins cannot
choose them. Backend choice is explicit and has no fallback. The offline runner supports compute, process execution and filesystem operations
inside the disposable snapshot; grants do not enable network, model calls,
findings writes or access to host files.

`create-pinned` captures the current generation and epoch. Ordinary legacy
sessions are not silently upgraded. `plugin-call` returns a JSON plugin outcome
whose result remains untrusted data, with success exit only for a succeeded
operation. App-server `run_plugin` is concurrent and cancellable; exact command
retries return durable outcomes without replaying effects. Stale generations or
changed host policy fail closed. Unresolved cleanup retains recovery metadata
and leases rather than pretending settlement. Help/schema/snapshot/hosted and
native doctor bypass harness loading; doctor does not validate harness state.
No plugin management, generation activation or legacy plugin parity is implied.

## Local report rendering

```sh
0sec-native report --input report.json --format json
0sec-native report --input report.json --format sarif
```

This renders an existing legacy report without running a scan, validating a
security finding, uploading results or opening native state. Provider, harness
and hosted credential configuration is bypassed. JSON preserves original fields;
SARIF follows the existing report renderer and records the actual native package
version as exporter version. No producer version is inferred from input data.

Input is capped at 16 MiB and read with a five-second deadline. Stdout writes
have a five-second deadline and respond to SIGINT/SIGTERM. Success exits 0,
signal cancellation exits 1, and malformed input, limits or I/O failures exit 2.
No output file is created implicitly; use shell redirection if desired. Failed
input validation emits no partial report, though interrupted output writes can
leave a partial stdout stream. This exporter does not establish source-review
or scanner parity.


Hosted credential files use literal `KEY=VALUE` lines, with blank lines and `#`
comments ignored. No shell commands, expansions or escapes are evaluated. Reads
are bounded to 64 KiB and five seconds; errors never include raw lines, tokens or
credential paths. Compared with the legacy warn-only loader, native resolution
rejects Unix files whose mode is not exactly 0600, final-component symlinks,
nonregular files, duplicate keys, quoted values and malformed entries. It never
changes file permissions itself. POSIX permission enforcement is unavailable on
non-Unix platforms; this is not a claim of Windows ACL validation. File fallback
requires absolute `HOME` (or `USERPROFILE` on Windows), without querying an OS
account database if those are absent. Help/schema still bypass all resolution.
Tests use only temporary home directories and loopback fixtures; no real
credential files are modified. Explicit hosted browser login is described below;
provider-specific device/OAuth login is not implemented by this command.

## Measured local fixture evaluation

```sh
0sec-native evaluation run --source-registry /absolute/registry.db \
  --plan frozen-plan.json --grants host-grants.json --output-dir ./new-evaluation
0sec-native evaluation status --directory ./new-evaluation
```

The plan uses `zero-evaluation::Plan`; grants are an explicit plugin-ID map of
`{"enabled":true,"trusted":false,"grants":["compute"]}` host policies. Candidate
artifacts cannot supply their own grants. The source registry is opened through
SQLite read-only access and is never initialized or promoted. The output directory
must be new. Plan/grants JSON inputs are bounded to 1 MiB and five seconds each.
Provider profiles, hosted credentials and native engine state are not loaded.
Global `--docker-bin`/`--smolvm-bin` select the installed backend executables;
backend/image identity remains fixed in the frozen plan, with no image pulls.

Run stdout contains only the measured report. Exit 0 means that the declared
fixture criteria passed, exit 1 means rejected or inconclusive, and setup/I/O
errors exit 2. Eligibility here does not grant production promotion or establish
security detection quality. Signals request cancellation and await the owned
runner's cleanup observation before returning the resulting report. Unknown work
retains its durable reservation and recovery evidence; the command never retries
or resumes an existing output directory.

Status reads a consistent snapshot without claiming ownership, changing interrupted
attempts, or starting guests. Its aggregate counts and verified receipt omit oracle
values, inputs and guest outputs. It can inspect an active run. Private retained
evidence remains in the evaluation directory; stdout writes have a five-second
limit and can be interrupted. Production receipt import, candidate generation,
canaries and native process replacement are separate remaining migration work.

`source-review --session SESSION --command-id COMMAND --request request.json`
submits explicitly selected files from a pinned snapshot through the configured
provider. The request specifies `provider`, `model`, `reservation`, and `source`
(`snapshot`, `selected_files`, `question`, `max_hypotheses`); provider profiles and
credentials use the existing `--providers` configuration. The command returns a
structured outcome and retained artifact hashes, without printing the source
bundle. Only citations matching retained file hashes and line ranges are accepted.
A successful command means the submission was structurally accepted: every
hypothesis remains `unverified`, and an empty submission is not evidence of safety.
Prose alone is not a result. This command performs no reproduction, patching,
behavioral validation, or uploads beyond the explicitly configured model request.
An exact command retry returns its durable result without rereading deleted source
or issuing another provider request. Failed or unknown operations exit nonzero.

## Retained operation artifacts

```sh
0sec-native --state .0sec/native/state.db artifact list --session SESSION --operation OPERATION
0sec-native --state .0sec/native/state.db artifact export --session SESSION \
  --operation OPERATION --name source.bundle --output retained-source.json
```

These commands open the existing schema-v4 journal read-only, without claiming
engine ownership, migrating state, recovering operations or loading credentials.
They work while an engine owns the journal. Listing exposes attachment names and
hashes. Export verifies the retained content hash and creates a new file atomically;
it never overwrites an existing destination. Files are private (0600 on Unix),
and source bytes are written only to the explicitly requested destination.
Output paths must be UTF-8 for the JSON receipt. An interrupted output stream or
failed directory sync can occur after the complete file was published; inspect
the destination before retrying. Repeated export to an existing path fails.

One-shot JSON output, schema/snapshot output and ordinary JSON configuration or
request reads have five-second deadlines and respond to shutdown signals. Engine
operations settle before their final JSON is written, so a stalled stdout reader
does not hold active guest work. Blocking host filesystem operations retain the
usual OS limitations; the exporter awaits its private writer before returning
from a handled signal.

`source-reproduce --session SESSION --command-id COMMAND --request request.json`
executes an explicit host-owned frozen plan against a successful source-review
operation in the same session. The request supplies `source_operation_id` and
`plan`: schema version 1, oracle version `zero-verification-exact-output-v1`,
retained hypothesis and source-bundle identities,
the original exact snapshot pin, pinned backend, limits, repeated attack cases,
and legitimate controls with exact exit/stdout/stderr observations (bytes are
base64 on the wire). Provider output cannot authorize this command or edit its
oracle. No provider configuration is needed to reproduce already retained source.

Exit zero means a completed assessment: either `observed_for_plan` or
`not_observed`. Inspect the assessment disposition; neither is a general
vulnerability-verification or safety verdict, and `vulnerability_reportable`
remains false. Inconclusive, cancelled, unknown and setup failures exit nonzero.
Signals cancel the owned child and await settlement/cleanup. Exact retries return
the durable result after source deletion without restarting the observation
matrix. Use `artifact list`/`artifact export` to inspect or retain the plan,
observations, and assessment attached to the resulting operation. This surface
does not propose probes, repair source, run arbitrary model-granted commands, or
establish a reportable finding.


## Explicit hosted browser login

`hosted login [--host URL] [--credentials /absolute/private/cloud.env]`
prints a sign-in URL on stderr and polls the existing hosted browser-session
endpoint. Open the URL yourself; the native CLI does not launch a browser or
shell. Host selection is the explicit flag, then `0SEC_CLOUD_HOST`, then
`https://cloud.0.security`; existing credential files/tokens are not used to log in.
`--timeout-ms` bounds the entire login to at most 300000 ms. Polling waits two
seconds between pending responses; expiry, rate limits, outages, invalid replies
and cancellation stop without replacing credentials. No separate OAuth device
endpoint or provider subscription authentication is implied.

Only after a ready credential arrives does the command save literal
`0SEC_CLOUD_HOST` and `0SEC_CLOUD_TOKEN` lines. The default destination is absolute
`HOME/.0sec/cloud.env`; a missing final `.0sec` directory is created mode 0700.
An explicit `--credentials` parent must already exist. On Unix the final directory
must be owned by the current user and mode 0700; any existing target must be an
owned regular file with mode 0600. Every directory is opened without following
symlinks. The new file is written privately, synced and atomically renamed over
an eligible existing credential file; no shell expansion or server-supplied file
path is used. Symlink or public destinations fail without replacing the old file.
Windows persistence is currently unsupported. This is stricter than legacy login.

Success prints JSON metadata only, never the token. `environment_override: true`
means a nonempty `0SEC_CLOUD_TOKEN` still takes precedence over the saved file;
login does not clear that environment variable. Custom `--token-env` is rejected
for login. Login bypasses engine state, provider profiles and harness configuration.
Signals before persistence leave credentials untouched; once atomic persistence
starts, its writer is awaited and an interruption reports that credentials were
saved. A directory-sync failure after atomic replacement also explicitly reports
the saved state. This command does not verify account funds or inference access.
All executable login fixtures use temporary homes and localhost services.

### Explicit retained source investigation

An `agent --request` JSON file may set `source_review_operation_id` to a succeeded
`source-review` operation in the same session. Its exact source snapshot must
match the agent execution profile. The model then receives `list_source_files`,
`read_source_lines`, and `search_source_text`, bounded to files retained by that
review. Results preserve file hashes and exact line citations; no host file read
or sandbox launch occurs during these tools. Omit the field to retain the existing
tool set. See [source tool authority and limits](../zero-engine/SOURCE-TOOLS.md).

### Continuing after a turn limit

An agent that completes its final tool round but reaches `max_turns` can return
`status: "turn_limit"` with `continuation_artifact`. Submit a new `agent` command
ID with `continuation_of` set to that operation, a new prompt, and the same
provider/execution/source/plugin authority. The engine reuses retained history
without rerunning prior tools. Turn limits still return a nonzero process exit;
missing checkpoints, cancelled/unknown operations and changed authority are
rejected. Unpriced usage holds remain reserved. See
[continuation boundaries](../zero-engine/CONTINUATION.md).

### Investigating an entire pinned source snapshot

Set `source_snapshot_tools: true` in an agent request to enable read-only source
tools over its explicit execution snapshot, without a previous source review.
Do not also set `source_review_operation_id`. The engine verifies a private copy,
retains its catalog, and removes it before reporting success. Reads return exact
hash citations; search reports files it could not inspect and result truncation.
Original-file changes after preparation do not affect observations. New
continuations require the original pin to remain available; exact retries do not.
A cleanup failure returns `Unknown` with a recovery path and cannot advertise a
continuation checkpoint. Full filesystem and cancellation limits are documented
in [the source tool contract](../zero-engine/SOURCE-TOOLS.md).
