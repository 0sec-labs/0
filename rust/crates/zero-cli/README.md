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
`session budget` reads persisted integer microcurrency units for inference reservations and charges. It opens existing state read-only, works while another engine owns the database, and bypasses provider/HTTP/harness configuration. It does not migrate state, recover work, release uncertain holds, or create a missing database.

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
The console reads follow-ups while a turn runs and acknowledges each durable
acceptance on stderr as `queued input INPUT_ID`. An acknowledgment confirms
persistence; if output was interrupted, inspect the queue before resubmitting an
unacknowledged line. Each accepted line gets a stable command ID; pending and
running inputs together are bounded to 50 and the newest input is rejected when full. No older input is
silently evicted. Provider, instruction and sandbox authority remain fixed.
Optional `continuation_of` selects the initial completed checkpoint; later inputs
link to the preceding queued input and continue only after it completes.

Stdout contains answer text only. Stderr contains queued input IDs, executing
command IDs, durable operation admissions and completed checkpoint IDs. EOF
drains accepted pending inputs; a final line without newline is accepted.
Ctrl-C/SIGTERM waits for active cancellation/cleanup, exits nonzero and leaves
pending inputs in the journal. Failed, cancelled or Unknown turns also stop
without dispatching the next input. Inspect the operation and budget before
reconciling unknown usage; reconciliation does not make an Unknown operation a
completed continuation. Queue rejection makes the console's eventual exit
nonzero, even if previously accepted inputs completed.

## Experimental full-screen terminal

```sh
0sec-native --providers providers.json tui --session SESSION_ID --request agent-profile.json
```

`tui` requires a terminal on both stdin and stdout. It launches an owned
`app-server` subprocess with the explicit state, provider and harness configuration;
the frontend never opens the state database. Omitting `--session` opens session
selection. Omitting `--request` allows inspection without a submission profile.
The profile prompt is never submitted on startup. An explicit profile
`continuation_of` selects the initial parent. Once an acknowledged input is
dispatched, that input retains its parent for exact retry; subsequent prompts
follow the pending queue or current retained conversation instead of repeatedly
forking from the initial parent. Unknown or ineligible outcomes require recovery.

Tab switches between sessions, conversation, durable queue, findings and web. Enter selects a
session or submits the conversation composer; bracketed paste inserts text,
including newlines, without submitting. Ctrl-N creates a session with
`--budget-limit` (default zero). Ctrl-R explicitly runs a selected pending input;
Ctrl-X cancels active work or the selected pending input. Ctrl-C cancels active
work, otherwise quits; Ctrl-Q quits. F1 shows help and Ctrl-L requests another
page; Ctrl-G returns to the newest conversation page. The display marks when
older pages replace its bounded history window. Opening a session never
automatically dispatches saved pending prompts.

The findings view discovers review references, then validates a selected review
before showing its unverified hypotheses. Enter opens a review or hypothesis;
Esc goes back. In hypothesis detail, `a`, `s` or `r` opens an accept, suppress or
reopen note. Enter and pasted newlines only edit the note; Ctrl-S explicitly
submits the decision. A revision conflict preserves the note and refreshes the
record; Ctrl-B explicitly rebases before another submission. Exact retries use
the same decision ID and distinguish the original receipt from current status.
Operator acceptance does not verify a security claim. No agent profile or model
call is needed for these operator actions.

History is a bounded display projection, with explicit text truncation. It is
not passed back as model context: continuation uses the engine's retained
checkpoint and its validation. Live text, exposed reasoning and tool fragments
are provisional; the journaled final result remains authoritative. The terminal
client accepts response frames up to 32 MiB; a larger response closes the UI
with an error. This does not delete the journaled outcome; history reads also
enforce their own retained-row and display limits.

Quit closes the owned protocol connection and waits for app-server cleanup.
Pending inputs remain durable. An interrupted inference can retain Unknown
status and a budget reservation; inspect its journal before retrying. A shutdown
timeout is reported as an error. Full legacy terminal parity, including approval
and question dialogs, legacy finding families and multi-audit navigation, remains open.

## Durable agent input queue

```sh
0sec-native --providers providers.json queue enqueue --session SESSION_ID \
  --command-id FOLLOWUP_ID --request agent-request.json
0sec-native queue list --session SESSION_ID --after 0 --limit 50
0sec-native --providers providers.json queue run --session SESSION_ID --input INPUT_ID
0sec-native queue cancel --session SESSION_ID --input INPUT_ID
```

Enqueue records an explicit `AgentRequest` without a provider call. Use
`--after-input PREDECESSOR_INPUT_ID` to continue from another queued input; leave
`continuation_of` absent in that request. Enqueue retries with the same command ID
and payload return the existing input; changing that payload is rejected. Run
requires an explicit input ID, respects pending FIFO order and returns an existing
operation receipt on exact retry. It never silently reruns uncertain work.
Cancelling a pending input does not interrupt a running operation. A cancelled
predecessor does not satisfy a follow-up's completion requirement.

The console automatically runs only inputs it accepted in this invocation.
After restart, inspect the queue and explicitly run the intended input ID with
the matching provider and execution configuration. Opening the engine never
automatically dispatches stored prompts. Queue list/cancel need no provider
configuration; run uses the existing succeeded-only operation exit convention.

Within `app-server`, `queue_agent`, `agent_queue` and `cancel_queued_agent` remain
available while `run_queued_agent` executes. A separate CLI process cannot access
the engine through these commands while another process owns its state database;
use the existing app-server connection, console or TUI for live input. Mid-turn
steering uses a separate durable receipt, described below.

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
0sec-native report --input report.json --format markdown
0sec-native report --input report.json --format html
```

This renders an existing legacy report without running a scan, validating a
security finding, uploading results or opening native state. Provider, harness
and hosted credential configuration is bypassed. JSON preserves original fields;
SARIF follows the existing report renderer and records the actual native package
version as exporter version. No producer version is inferred from input data.
Markdown includes legacy summary, warnings, finding details, remediation and
reproduction steps. It escapes supplied markup, discloses evidence/step elisions,
and says “No findings reported” for empty reports without inferring target safety.
Evidence excerpts use 4,000 Unicode characters and show at most 20 PoC steps;
JSON/SARIF retain complete evidence. Missing Markdown metadata is marked
“not supplied.” HTML is a self-contained report with severity-sorted cards,
warnings, proof steps and remediation; all supplied markup and URLs are inert
text, with no scripts or external resources. It uses the same evidence/step
limits and explicit elision notices. Missing metadata remains “not supplied”;
no empty report gets a clean verdict. Rendering does not redact supplied secrets.

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

### Adaptive review submissions

In an `agent --request` file, combine `source_snapshot_tools: true` with
`source_submission_max_hypotheses: 8` (or another limit from 1 to 32) to require
structured findings after investigation. The model submits selected paths and
hash/line citations through `submit_source_hypotheses`; prose alone cannot finish
this mode. `result.source_review` retains unverified hypotheses and artifact
hashes. Its operation ID can be used as `source_operation_id` for an explicit
`source-reproduce` request. This does not infer reproduction or a clean verdict.

### Native source hypothesis reports

```sh
0sec-native --state .0sec/native/state.db source-report --session SESSION --operation REVIEW_OPERATION --format json
0sec-native --state .0sec/native/state.db source-report --session SESSION --operation REVIEW_OPERATION --format markdown
0sec-native --state .0sec/native/state.db source-report --session SESSION --operation REVIEW_OPERATION --format html
```

This read-only export accepts a succeeded dedicated source review or adaptive
structured submission in the named session. It revalidates retained submission
and provider evidence without acquiring engine ownership, loading provider or
harness configuration, or rereading the original project. It works while the
engine owns the journal and after the original source is removed.

The separate native report contains unverified hypotheses, citations and the
four submission artifact hashes. It does not embed source files, private snapshot
paths, full provider transcripts, or execution artifacts. Claim text is supplied
content and may itself contain sensitive information; rendering does not redact
it. Empty reports establish no safety conclusion. Legacy findings, SARIF mapping, and managed report publication are not included.
Reproduction and repair assessments require the explicit links described below.
JSON explicitly records `report_kind: source_hypotheses`, `verification_state:
unverified` and `security_conclusion: not_established`. Reads and stdout writes
have five-second deadlines; interrupted writes can leave partial stdout.

To include observations and a candidate validation, explicitly select their
operation IDs. Each repair also requires its baseline reproduction selection:

```sh
0sec-native source-report --session SESSION --operation REVIEW_OPERATION \
  --reproduction REPRODUCTION_OPERATION --repair REPAIR_OPERATION --format html
```

Repeat `--reproduction` and `--repair` for up to 32 distinct links combined.
Linked exports use schema version 2; a review-only export preserves version 1.
The exporter re-assesses retained child observations and checks each operation's
session, source hypothesis, frozen plan, requests, artifacts and terminal journal
outcome. Repair phases additionally bind the authorized replacement, candidate
receipt and derived plans to the original baseline. It performs no new execution.

A report may contain not-observed, inconclusive, cancelled or unknown observations;
export success means the selected evidence was validated and rendered. It never
turns those statuses into a successful test or marks a hypothesis verified.
`observed_for_plan` and `validated_candidate_for_plan` remain limited to the exact
frozen cases. Missing or inconsistent evidence makes export fail; an early failed
operation without retained assessment cannot be included as an assessed result.
Raw command outputs, source/replacement bytes, private paths and recovery paths
are omitted; recovery is represented by its count. Publication and disclosure
remain separate capabilities.

## Operator triage of source hypotheses

`findings reviews --session SESSION` discovers retained `source.review`
references without loading source or evidence bytes. Use `--before-sequence N`
with the returned `next_before_sequence` to continue; `--limit` accepts 1..32.
Each call scans at most 128 journal rows, so an empty page can still have a
continuation cursor. Refresh from the beginning to discover new attachments.

Discovery includes partial and failed operations with retained review attachments.
A reference is not a validated finding or a security verdict. Selecting it with
`findings list/show` performs the existing provenance checks and can fail if the
operation or its retained evidence is incomplete or inconsistent. Discovery is
read-only and works while an engine owns the database, without provider or
harness configuration.

`findings list --session SESSION --operation SOURCE_OPERATION` returns a bounded
page of hypotheses from provenance-checked native reviews, with their independent
operator status. The hypotheses remain unverified.
`--offset N --limit 32` pages the immutable review order; advance by the number
returned until empty. `findings show` adds `--hypothesis ID` and accepts
`--after-revision N --limit 50` for immutable decision history. Read commands
bypass provider/harness configuration and engine ownership; missing or old-schema
state is rejected without initialization or migration.

`findings accept`, `suppress` and `reopen` require the same exact target plus
`--command-id ID --expected-revision N`, with optional `--note TEXT` (4 KiB).
Revision zero represents a hypothesis with no decisions. Every fresh decision
advances it; stale writes fail. Retrying identical arguments under the same
triage command ID returns the original decision and current finding, marked
`duplicate: true`, without undoing later decisions. This command namespace is
separate from execution operations.

These changes record operator disposition only. They preserve hypothesis
verification state, original review artifacts, reproduction/repair evidence and
budget accounting. There is no implicit family update, legacy DB import,
provider request or publication. Writes use engine ownership; an active app-server
can accept the corresponding typed `triage_source_finding` command.


## App-server model progress

`model_progress` events are advisory display updates for an identified inference
operation and optional parent. The app-server uses a separate 128-item queue for
them; replies and operational events take priority. Sequence numbers start at
one per paid operation and may have gaps. Display caps can suppress the remaining
updates, and queued progress can arrive after a terminal reply: clients must
ignore late updates and use the final completion as truth. Tool fragments are
never executable calls, and progress carries no authoritative usage.

The line console and one-shot commands retain their prior output behavior. A
full-screen client can consume the existing app-server wire without owning the
engine or altering its journal. The existing five-second stdout deadline and
transport-disconnect shutdown still apply; a full or closed progress queue alone
does not cancel paid work or sandbox tools.

Progress and operational events use independent queues, so progress may precede
its admission notification. Correlate by session/operation IDs rather than
assuming admission-first delivery.


## Explicit mid-turn steering

In the fullscreen Conversation view, Ctrl-T sends the held composer to the
admitted active root operation; Enter still queues a separate follow-up. The
console recognizes `/steer TEXT` while an admitted turn runs; `//steer TEXT`
queues the literal `/steer TEXT`. Idle, empty, late or rejected steering never
falls back to a queued prompt. Rejected console input makes the eventual exit
nonzero. The profile's provider, tools, instructions and budget remain fixed.

Steering accepts at most 16 KiB of UTF-8 text, 32 pending messages and 128 total
messages per target operation. It waits for a complete model boundary and does
not interrupt an in-flight provider request or extend the turn budget. Receipt
states are Pending (durably accepted), Captured (bound to an inference request,
not proof of provider receipt), and Undelivered (not captured before completion
or interruption). Cancellation may leave usage Unknown while preserving an
Undelivered message. Receipt status, not live text, is authoritative.

```sh
0sec-native --state .0sec/native/state.db steer list \
  --session SESSION_ID --operation OPERATION_ID --after-sequence 0 --limit 50
```

`steer list` works while another process owns the engine. It reads an existing
state database without migration/recovery, providers, harness loading or network
calls; it does not create missing state. Pages contain at most 100 records / 1 MiB.
Advance the cursor to the last returned sequence until empty; refresh from zero
to observe mutable statuses. TUI reopening loads the newest displayed operation's
receipts. Live TUI sends always target its active root; app-server `SteerAgent`
also accepts an explicitly identified running delegated child. App-server sends
use session/operation/command IDs plus exact prompt text; exact retries retain
identity, while changed payloads conflict. TUI errors retain the draft/command ID
for retry; acknowledgments remain associated with their original operation.

## Operator questions (information only)

Set `"operator_questions": true` explicitly in an agent profile to offer
`ask_operator`. The default is false and keeps the existing tool surface and
request identity. It accepts one to four structured questions, each offering
choices or custom text. Answers grant no tools, filesystem access, networking,
scope changes or other permissions; the actor's original authority stays fixed.
Questions and answers are retained in the journal as untrusted tool data.

The terminal shows a waiting count without stealing the composer or Findings
note. Ctrl-O opens the inbox; Enter selects a question. Arrows/Tab move through
choices and custom fields; Space selects choices. Enter and Unicode paste only
edit a custom field. Ctrl-S explicitly submits all answers. Ctrl-D explicitly
dismisses. Esc closes the overlay while retaining its draft; Ctrl-U explicitly
discards the local draft and returns to the inbox without answering/dismissing.
Submitted drafts freeze their question ID, request hash, command ID and answer
for exact retry. Ctrl-X/Ctrl-C cancel active work; Ctrl-Q exits and awaits cleanup.

In the line console, use the printed durable question ID:

```text
/answer QUESTION_ID {"type":"answer","answers":[{"question_index":0,"selected_indices":[0]},{"question_index":1,"custom_text":"Unicode λ\nadditional detail"}]}
/dismiss QUESTION_ID
```

Invalid answer commands never become queued prompts. `//answer` and `//dismiss`
escape literal follow-up lines. EOF while a pending question needs an answer
cancels owned work, including questions first arriving after EOF; it never
fabricates dismissal or an answer. A rejected console answer makes the eventual
exit nonzero. Ordinary EOF continues to drain accepted work that needs no answer.

```sh
0sec-native --state .0sec/native/state.db questions list --session SESSION_ID
0sec-native --state .0sec/native/state.db questions show \
  --session SESSION_ID --question QUESTION_OPERATION_ID
```

These commands read existing state while an engine owns it, bypass provider and
harness configuration, and perform no migration, recovery or network calls.
Lists support `--root`, `--after-sequence` and `--limit` (1–100, default 50) with a
1 MiB page bound. Advance to the last returned sequence until empty; refresh from
zero for updated statuses. The terminal keeps a 20-record page, up to 20 separately retained pending
records, and its selected detail, retaining known pending questions across concurrent older page replies;
it refreshes those pending identities individually. Custom answers are limited
to 16 KiB each; whole request/decision packets are limited to 64 KiB.

Pending, Answered, Dismissed, Cancelled and Interrupted are distinct retained
states. Answered means a saved decision, not proof the model consumed it. The
TUI owns a private app-server: exiting cancels its workers, and reopening shows
receipts without restarting lost waits or replaying effects. Plain batch `agent`
and fresh `queue run` reject question-enabled work before operation admission;
use app-server, console or TUI for an answer channel. Already dispatched exact
cached receipts can be returned without creating a waiter. Existing database
migration remains available for ordinary queue commands.

Opt in to **one-invocation tool approval** with an explicit agent profile field:

```json
"tool_approval_policy": {"require_approval": ["execute_snapshot"]}
```

Offered offline snapshot/plugin aliases and the explicitly configured native
`http_request` tool are supported. Gated Docker profiles
must already use `sha256:<64 lowercase hex>` or `name@sha256:<64 lowercase hex>`;
resolve and select an immutable local image before starting. Mutable image tags
are rejected before provider admission. Existing profiles without this policy
retain their prior behavior; this policy does not implement legacy autonomy modes
or grant network, host filesystem, or additional tool authority.

The console prints the approval ID, exact intent hash, backend/tool preview and
an explicit `preview_truncated` flag. Inspect the complete retained intent using
`approvals show --session ID --approval ID --full-intent` (with the same global
`--state`). `approvals list --session ID [--root ID] [--after-sequence N] [--limit N]`
and `approvals show` are read-only and work while the engine owns its database;
they bypass provider/harness configuration. Lists are bounded; advance by the
last returned sequence until an empty page.

Decide in the owning console with `/approve APPROVAL_ID sha256:HEX` or
`/deny APPROVAL_ID sha256:HEX`. Both the explicit ID and complete displayed digest
are required. Identical repeated commands reuse their decision identity (up to
128 retained console intents); changed decisions never reuse an approval grant.
`//approve` and `//deny` insert literal follow-up text. Invalid control commands,
informational `/answer`, ordinary text, and steering cannot authorize execution.
EOF with a pending approval cancels owned work, including approvals first
reported after EOF; it never synthesizes approval or denial.

In the TUI, **Ctrl-P** opens a separate permission inbox without clearing question,
findings, or conversation drafts. Enter selects an approval for inspection only.
**Ctrl-A** approves that exact invocation; **Ctrl-D** denies it. Paste, Enter,
Space, and the question submission key Ctrl-S never decide permission. Esc closes
and retains an uncertain decision for exact retry; Ctrl-U explicitly discards
only the local intent. Ctrl-X still cancels active work. Preview text is untrusted,
may be truncated, and is not the hashed authority; use the full-intent command to
inspect all retained fields before deciding.

`Approved` means a permission receipt exists. `Consumed` means that permission was
bound to an admitted effect, not that the tool ran or succeeded; inspect the effect
status and receipt. Reopening the UI never resumes an interrupted approval.
Plain `agent` and fresh `queue run` reject approval-enabled profiles because they
have no decision channel. Cached already-admitted exact retries remain readable;
app-server, console and TUI support live decisions. These controls authorize one
invocation, not an alias, future argv prefix, sibling actor, or source directory.

## Scoped target HTTP

`--http-profiles PATH` loads an explicit, strict JSON map of named target profiles.
It is separate from `--providers`: provider credentials never grant target access.
The same option works with `agent`, `console`, `app-server`, and `tui`; the TUI
forwards it to its owned app-server. An agent request selects one host-configured
profile with `"http_profile":"target"`. Omitting that field preserves the existing
offline tool set and request identity.

A minimal bounded local-target profile looks like this:

```json
{
  "target": {
    "policy": {
      "schema_version": 1,
      "base_url": "http://127.0.0.1:8080/target/",
      "in_scope": ["127.0.0.1"],
      "out_of_scope": [],
      "denied_hosts": [],
      "allowed_path_prefixes": ["/target"],
      "denied_path_prefixes": [],
      "allowed_methods": ["GET", "POST"],
      "allowed_headers": ["accept", "content-type"],
      "redirect": {"mode": "manual"},
      "limits": {
        "timeout_ms": 5000,
        "max_request_body_bytes": 4096,
        "max_response_wire_bytes": 65536,
        "max_response_decoded_bytes": 65536,
        "max_request_header_bytes": 8192,
        "max_request_headers": 32,
        "max_response_header_bytes": 8192,
        "max_response_headers": 32,
        "max_dns_answers": 16,
        "max_dns_cname_depth": 4,
        "max_dns_queries": 8
      },
      "rate": {
        "default": {"requests_per_interval": 10, "interval_ms": 1000, "burst": 2},
        "per_host": {},
        "jitter_ms": 0
      },
      "budget": {
        "max_requests": 8,
        "max_request_body_bytes": 32768,
        "max_response_decoded_bytes": 524288
      }
    },
    "auth": {
      "revision": "credential-version-1",
      "headers_env": {"authorization": "TARGET_AUTHORIZATION"}
    }
  }
}
```

Omit `auth` for an unauthenticated target. `TARGET_AUTHORIZATION` must contain the
entire header value, including `Bearer ` when needed. The host must change the
opaque `revision` whenever it rotates that credential. Only the revision, exact
origin and header names are captured as public authority; environment references
and credential values stay out of durable metadata. Authentication is injected
only for its exact origin. Invalid or absent configured credentials fail; there
is no unauthenticated fallback. Do not put a public `policy.auth` descriptor in the
file: the loader derives it from the private configuration.

The model can supply only `url`, `method`, `headers`, and optional UTF-8 `body` to
`http_request`. Method defaults to `POST`; content type defaults to
`application/json`. Scope, deny rules, path boundaries, methods, header allowlists,
redirects, deadlines and aggregate budgets remain host authority. Denies take
precedence. Private destinations require an explicitly private literal-IP or
localhost base anchor; a public hostname resolving to a private address is not
such an anchor. Per-host rate keys are canonical hostnames without ports.
Redirect modes are `manual` (default), `error`, or `follow` with `max_hops` 1–5;
each followed hop is authorized and accounted independently, and crossing an
origin drops caller headers and saved authentication.

Profile files must be regular JSON files, at most 1 MiB, containing at most 32
unique profiles; unknown fields fail. Request bodies are capped at 1 MiB,
response wire and decoded bodies at 16 MiB each, request and response headers at
64 KiB/128 fields each, and request deadlines at 120 seconds. Smaller configured
limits apply. Saved-cookie sessions, automatic reauthentication, proxies, TLS
verification bypass, and model-driven scope expansion are unsupported.

Inspect retained network observations without loading any profile, credential,
provider or engine owner:

```sh
0sec-native --state state.db http show --session SESSION --operation HTTP_OPERATION
0sec-native --state state.db http show --session SESSION --operation HTTP_OPERATION --evidence
```

The ordinary view validates the retained provenance and shows status, manifest and
artifact identities. `--evidence` adds the exact retained **redacted** body as
base64 with an explicit byte count; it does not interpret arbitrary bytes as
UTF-8. Wire, decoded and retained-redacted byte counts are distinct. Evidence
hashes identify retained redacted bytes, not the original network stream. Saved
authentication values and sensitive response headers are redacted before engine
retention. HTTP 4xx/5xx can be complete observations; a dispatched incomplete
response remains uncertain and an exact retry reads its receipt without sending
another target request. Neither a response nor its approval is a vulnerability
verification or a safety verdict.

### Structured web workflows and retained evidence

Use the existing `agent --request web.json` entry point with `http_profile` and
`web_submission_max_hypotheses: 1..32`. Omit `execution` for an HTTP-only actor;
no snapshot or Docker profile is fabricated. The host HTTP profile still defines
scope, credentials, rate and byte budgets. Terminal web submissions contain
**unverified hypotheses**, with citations into retained redacted responses.
A failed/cancelled run can retain useful observations without a terminal review.

```sh
0sec-native web runs --session SESSION
0sec-native web show --session SESSION --operation WEB_RUN
0sec-native web observations --session SESSION --operation WEB_RUN
0sec-native web findings --session SESSION --operation WEB_RUN
0sec-native web evidence --session SESSION --operation HTTP_OPERATION
0sec-native web range --session SESSION --operation HTTP_OPERATION \
  --expected-manifest sha256:DIGEST --offset 0 --limit 4096
```

These reads bypass current profile files and do not acquire engine ownership or
contact targets. Metadata includes completeness, lifecycle status, header
indices, retained body digest and byte counts. Range responses contain exact
base64 bytes, at most 64 KiB; offsets refer to redacted decoded bytes, not raw
network data. Catalog pages can be empty with an advancing cursor. Continue
`--after-sequence`/`--before-sequence` as returned, rather than assuming exhaustion.

`web finding` adds `--hypothesis ID` and decision-history pagination. `web accept`,
`suppress`, and `reopen` require `--command-id`, `--expected-revision`, and the
explicit run/hypothesis; `--note` records operator intent. Acceptance does not
change the hypothesis's `unverified` state or establish reportability.

`web verify-prepare --session SESSION --plan plan.json` validates a host-authored
plan and prints the exact complete-plan intent and digest without dispatch.
`web verify --session SESSION --command-id ID --plan plan.json --expected-intent
sha256:DIGEST` executes its fresh bounded attack/control matrix. If inherited
HTTP policy requires approval, also supply `--approve-plan sha256:DIGEST` with
that exact digest. There is no implicit approval or per-case approval shortcut.
A retained terminal command retry returns its outcome and does not resume calls.

`web report --session SESSION --operation WEB_RUN --verification VERIFICATION_ID
--format json|markdown|html` exports the selected workflow and optional explicit
verification links (repeat `--verification`). Export revalidates evidence and
reassesses linked attempts offline. An observed result qualifies only the frozen
plan under the same static identity and existing target state; it is not a
cross-principal vulnerability verdict. Partial/empty reports never imply safety.
See [the workflow contract](../../WEB-WORKFLOW.md) for oracle/state limitations.

The terminal's fifth **Web** view works without a provider profile. Select a run
with Enter, then Enter for hypotheses or `e` for retained HTTP operations.
In hypothesis detail, `[`/`]` select a citation and `e` inspects its exact
manifest/range. `Ctrl-L` pages lists/history or the next 4 KiB of body evidence;
`Ctrl-G` refreshes; Esc goes back. Body display labels UTF-8 replacement and
also shows exact base64. `a`/`s`/`r` opens an operator decision note, Ctrl-S submits,
and pasted text/Enter only edits. Conflicts preserve the note and revision;
Ctrl-B explicitly rebases to a refreshed record. No TUI key silently executes a
verification plan; use the explicit prepare/verify CLI workflow.

Web reports bound discovery to 4096 scanned journal rows, 128 displayed observations,
and 64 MiB of validated body inspection plus one response sentinel. Unavailable
or omitted evidence is labeled explicitly. Up to 32 explicitly linked verification
receipts have their own matrix and provenance read bounds; that work is separate
from the discovery-body prefix. Oversized reports fail explicitly.

### Agent-chosen web experiments

A host request can opt in with `"web_experiment_policy":{"schema_version":1,
"max_experiments":3,"max_cases":4,"max_repeats":2}` and `http_profile`.
The agent can propose an attack/control response matrix, observe independent
measurements, revise its conjecture, delegate permitted work, or stop without
using the allowance. This does not require terminal hypothesis submission;
`web_submission_max_hypotheses` remains a separate opt-in. The policy supplies
limits, not a minimum number of experiments or a vulnerability verdict.

Inspect retained work without provider or target configuration:

```sh
0sec-native web experiments --session SESSION --operation WEB_RUN
0sec-native web experiment --session SESSION --operation WEB_RUN --experiment EXPERIMENT
0sec-native web report --session SESSION --operation WEB_RUN \
  --experiment FIRST_EXPERIMENT --experiment REVISED_EXPERIMENT --format html
```

Experiment list pages use `--after-sequence` and `--limit` (1–32); an empty scan
window with `next_after_sequence` still has more records. Detail binds the actor,
model turn, tool call, conjecture revision, frozen predictions, and independent
measured attempts. `assessment.plan_sha256` identifies the experiment's frozen
matrix. Artifact byte digests for `experiment.hypothesis` and `experiment.matrix`
identify retained wrappers; they are distinct from conjecture and prediction
matrix identities. Running experiments have no terminal assessment. Cancelled
and uncertain results retain their partial observations.

Reports include only explicitly selected experiment IDs, with at most 32
combined experiment/host-verification links. Empty experiment arrays are omitted
from the existing version-1 report schema. A matched prediction means only that
this exact matrix matched under the same static identity and existing target
state: it is not a generic verified finding, reportability grant, or evolution
promotion. The existing HTTP account, experiment allowance, model session
budget, and cancellation ownership remain shared by joined children and explicit
continuations. Inherited approval policy still gates an exact whole experiment
when required; ordinary Enter, pasted text, questions, and steering cannot grant
that approval.

In the TUI's Web view, select a run and press `x` for its experiments, then Enter
for detail. Up/Down selects a measured attempt and `e` opens its retained evidence;
`p` follows the retained prior-revision link. Ctrl-L pages and Ctrl-G refreshes.
These controls inspect records and never start an experiment.

The TUI labels budget snapshots with their local receive age, refreshes periodically
during active work, and supports F2 for an independent refresh. A failed read keeps
the old values visibly stale. This is session accounting, not a combined campaign
or HTTP allowance. Cancellation acknowledgments retain their exact target; late
acknowledgments cannot overwrite the final result or affect a newer turn. A common
lifecycle strip remains visible over help, question and approval editors.

### Paired strategy qualification

`strategy create --command-id ID --plan host-plan.json` freezes a private host plan and captured provider identities. The version-1 plan selects the `strategy_advisory_v1` renderer and `local_web_marker_v1` fixture oracle, a fixed baseline/candidate pair, distinct development/final scenario families, repetitions, aggregate campaign limits and expiry. Candidate advisory text grants no tools or budget. Do not include private fixture markers in public instructions, tasks or advisory text. Creation validates the plan before engine admission and never prints its private contents.

Run each lane explicitly with the configured provider:

```sh
0sec-native --state state.db --providers providers.json strategy create --command-id paired-1 --plan host-plan.json
0sec-native --state state.db --providers providers.json strategy run --campaign CAMPAIGN --lane development
0sec-native --state state.db strategy dev-feedback --campaign CAMPAIGN --format text
0sec-native --state state.db --providers providers.json strategy run --campaign CAMPAIGN --lane final
0sec-native --state state.db strategy report --campaign CAMPAIGN --format text
```

Final requires completed development for the same frozen pair and consumes a protected exposure before scenario delivery. Development never automatically starts final. This is `qualification_only`: independently measured fixture improvement is neither generic security verification nor permission to promote a strategy. Before final, the combined report remains inconclusive with `protected_final_not_run`. Development feedback excludes protected final rows and verdicts. The first adapter uses local owned fixtures, with real configured model calls charged to the shared campaign; it does not add a mandatory approval step for every case or experiment.

`strategy status --campaign ID` and `strategy runs --campaign ID --after-sequence 0 --limit 50` inspect retained aggregate accounting and bounded run metadata. Status, runs, report and dev-feedback default to JSON; `--format text` provides bounded terminal-safe text. These reads work while an engine owns the database, require no provider/target credentials, and never replay effects. Advance run pages using `next_after_sequence` until absent. Status exposes its journal sequence/time and separately reports actual charges, unresolved holds and active/unknown runs. Report usage is reconstructed from retained accounting without an as-of timestamp; request status for a snapshot with its sequence and time. Reservations constrain admissions, not arbitrary provider invoice overruns.

A completed measurement report, including `not_improved` or development-only `inconclusive`, is successful command delivery. An explicitly signal-interrupted run exits nonzero after emitting its retained result and cleanup. Ctrl-C/SIGTERM during a foreground run closes campaign admissions and waits for owned actor/fixture cleanup through the engine lifecycle. An app-server client can send `CancelStrategyCampaign` on its owning connection. There is no second-process CLI cancellation IPC: readonly inspection does not take ownership or imply that a cancelled campaign has finished cleanup. Interrupted runs are retained without replay, unresolved usage remains held, and a fresh session does not refill campaign allowances. This controller does not implement candidate-pool proposal or production promotion.

### Advisory registry capture and measured eligibility

The explicit strategy adapter uses a verified graph with retained plugin components and one `strategy:advisory` component. It does not require a fake Docker launch for an HTTP-only strategy. Bootstrap is an explicit, **trusted unmeasured baseline**, permitted only for a fresh registry. It really installs the supported advisory capture; it is not an evaluation or an arbitrary candidate activation route.

```sh
0sec-native strategy registry bootstrap --host host.json --baseline baseline.json --command-id initial-baseline --reason 'Trusted initial host baseline'
0sec-native strategy registry status --registry /absolute/registry.db --format text
0sec-native strategy registry register --registry /absolute/registry.db --baseline-generation BASELINE_SHA --advisory candidate.json
```

`baseline.json` and `candidate.json` are strict `{"schema_version":1,"advisory_utf8":"..."}` artifacts. Registration copies the verified baseline manifest and changes only its advisory component; it grants no eligibility and preserves all other components and authority. Its generation digest differs from the advisory artifact digest. Existing active plugin-only registries are not silently converted by bootstrap.

The explicitly selected host JSON contains `registry` (absolute path), `engine_artifact` (digest), `plugins` (the existing enabled/trusted/grants map) and `strategy` (`StrategyHostAuthority`). The authority freezes the host template, public provider identities/rates, named runtime HTTP policy, campaign limits, accepted protected suite digests, gain criteria and canary requirement. Credentials remain in separately selected provider/HTTP profile environment references. Descriptor artifacts identify supported semantic versions; they do not attest that an arbitrary different executable is running.

Bootstrap additionally requires `bootstrap: {state_schema, compatible_state_schemas, initial_state, artifacts, plugin_components}`. `artifacts` maps exact `sha256:...` digests to local files (relative paths resolve from the host JSON directory); `plugin_components` maps only `plugin:ID` names to retained manifest digests. Include the engine and complete plugin artifact closure. Inputs are hash-checked and bounded to 64 MiB before insertion. The CLI adds canonical advice, generated host-policy bytes and the fixed graph-v2 configuration; the harness retains compiled renderer/evaluator descriptors. Unknown configuration fields fail. The bootstrap bundle can remain in the host file for exact retry; it is not replayed when configuring ordinary runtime capture.

Explicit strategy sessions derive requests from their immutable captured host authority:

```sh
0sec-native --state state.db --providers providers.json --http-profiles http.json --strategy-host host.json strategy session create --budget-limit 100
0sec-native --state state.db --providers providers.json --http-profiles http.json --strategy-host host.json strategy agent --session SESSION --command-id turn-1 --prompt 'Investigate the authorized target'
```

Session creation defaults to a zero budget unless specified. New work needs matching configured providers/HTTP authority and the supported current generation. Existing captured actors and joined children retain their exact advice; stale sessions never silently switch strategies. Fresh work on a stale capture can be rejected. Exact retained replies and history do not replay effects. A free-form `session create --generation` label cannot impersonate this verified mode. Existing generic agent requests retain their old behavior. The fullscreen/line console do not automatically translate arbitrary queued profiles into strategy-session commands; use these explicit wrappers or the corresponding app-server protocol.

Bind a campaign **before** either evaluation lane by naming an inert candidate and the real host registry:

```sh
0sec-native --state state.db --providers providers.json --strategy-host host.json strategy create --command-id measured-pair --plan private-plan.json --candidate-generation CANDIDATE_GENERATION
0sec-native --state state.db --providers providers.json strategy run --campaign CAMPAIGN --lane development
0sec-native --state state.db --providers providers.json strategy run --campaign CAMPAIGN --lane final
0sec-native --state state.db strategy eligibility prepare --registry /absolute/registry.db --campaign CAMPAIGN
0sec-native --state state.db strategy eligibility import --registry /absolute/registry.db --campaign CAMPAIGN --command-id import-1 --expected-evidence EVIDENCE_SHA
0sec-native strategy eligibility show --registry /absolute/registry.db --receipt RECEIPT_SHA --format text
```

Preparation returns `evidence_sha256` and the exact descriptor; it creates no grant. Import returns `receipt_sha256` for `show`, the immutable receipt, duplicate status and current usability. The expected digest correlates immutable intent, not an interactive approval ceremony. Initial import accepts independently source-verified evidence, never uploaded report JSON, model-authored scores or a caller pass flag. The bounded private evidence closure is retained so registry-only inspection can run the same validator without the source database, credentials or target. Missing/corrupt chunks fail closed.

Historical unbound campaigns remain `qualification_only`; binding cannot be retrofitted. Only complete independently improved, correctly bound Development/Final evidence with settled accounting and cleanup can grant the narrow measured scope. Registry identity, baseline epoch/state, whole generation diff, host policy and exposure are revalidated atomically. Exact successful import retry resolves from the registry before requiring the source or current provider configuration, and returns the original receipt with current usability. Changed intent conflicts. A stale receipt remains historical evidence; it is not fresh permission.

Status, preparation and receipt inspection run without engine ownership or unrelated provider/HTTP/harness loading. Mutable registry status is labelled with observation time; a receipt's measurement and current usability are distinct. Measured eligibility is not runtime activation, generic security truth, or proof that a required canary ran. Import preserves the current generation/state/leases. No candidate `activate` or canary success stub is exposed in this CLI.

### Autonomous advisory search

`strategy search` asks a configured proposal model for bounded advisory candidates, measures each against the captured baseline on Development fixtures, and feeds back independently reconstructed Development results. A proposal can stop the loop before its limit. It changes only advisory text; the host template, provider routes/rates, tool authority, private fixtures and scoring remain frozen.

```sh
0sec-native --state state.db --providers providers.json --strategy-host host.json strategy search create --command-id search-1 --plan private-search.json
0sec-native --state state.db --providers providers.json --strategy-host host.json strategy search run --campaign CAMPAIGN
0sec-native --state state.db strategy search status --campaign CAMPAIGN --format text
0sec-native --state state.db strategy search candidates --campaign CAMPAIGN --after-sequence 0 --limit 50
0sec-native --state state.db strategy search candidate --campaign CAMPAIGN --candidate CANDIDATE --format text
0sec-native --state state.db strategy search report --campaign CAMPAIGN --format text
```

The strict private search plan contains `schema_version`, a public `objective`, a `proposer` (`provider`, `model`, `instructions`, `reservation_micro_usd`, `max_output_tokens`), Development-only `scenarios`, `repeats`, `max_proposals`, `max_candidates`, aggregate `limits`, `expires_at_ms` and `minimum_development_gain`. Baseline and evaluation host authority come from the actual configured strategy capture. There is no caller candidate or mutable host-policy field. Do not place private fixture answers in the public objective or proposer instructions. Invalid plans fail before engine admission and their contents are not echoed in parser diagnostics.

Create freezes the plan and account without calling a model. Run explicitly starts that bounded loop; it does not request approval for each candidate. One durable campaign account covers proposal inferences and every candidate's baseline/evaluation actors, delegates, HTTP and experiments. New actor sessions do not refill it. Failed proposals consume admitted attempts and actual known usage; uncertain usage retains its reservation. Actual provider charges can exceed an estimate, so reservations are admission limits rather than an invoice guarantee. Unspent allowances do not require the model to keep searching.

A version 1 plan implements **Development search only**, with its existing behavior unchanged. A version 2 plan requires an additional private `protected_final` object: `scenarios` (Final lane only), `repeats` (2–3), and `minimum_gain`. Its exact Final corpus commitment must already be accepted by the captured host authority. Final scenarios require distinct families/markers and both positive and negative controls. All Development and possible Final runs must fit the same frozen account and run-slot limit.

For version 2, the native proposal tool also accepts `{"action":"select_final","evaluation_id":"EVALUATION_ID","rationale":"..."}`. The model can select only a previously completed, independently improved Development evaluation from its authenticated feedback. Selection permanently seals proposals and consumes the protected exposure before fresh Final work. Stop, candidate limits and proposal limits never automatically select a winner. A candidate cap still permits a version 2 model to select or stop while proposal and spending allowances remain. No `--force-final`, Final lane override, canary, automatic promotion or activation flag is supported.

Reports retain every proposal, including unsuccessful attempts, every Development evaluation, selection, available Final measurements and total charges/holds. Selection and allocated run slots do not prove that Final completed. Final results never return to the proposer. Partial, cancelled or uncertain work remains visible and cannot become a successful measurement by retrying the command.

A complete version 2 search uses its own source-verified evidence route:

```sh
0sec-native --state state.db strategy search eligibility prepare --registry /absolute/registry.db --campaign CAMPAIGN
0sec-native --state state.db strategy search eligibility import --registry /absolute/registry.db --campaign CAMPAIGN --command-id search-import-1 --expected-evidence EVIDENCE_SHA
0sec-native strategy search eligibility show --registry /absolute/registry.db --receipt RECEIPT_SHA --format text
```

Preparation and import independently reassess the complete search history, not a selected pair projected into an older report. The bounded portable closure includes all proposal and evaluation sessions, protected selection/exposure and aggregate accounting; export fails explicitly above its supported 64 MiB expanded bound. Registry inspection can reassess the retained closure after the original source and provider configuration are removed. Exact successful import retry resolves from the registry first; changed intent conflicts. Import preserves the active generation, state and leases. Measured eligibility is not activation, a completed canary, or a general security conclusion. The existing fixed-pair `strategy eligibility` route remains separate.

Status, candidate pages/details and reports work without engine ownership or provider/host configuration. They show aggregate charges and unresolved holds, separately from proposal rationale and measured results. Text output is bounded and terminal-safe. Use the returned page cursor until absent. A retained terminal run can be read or retried without replaying model/target calls; restart does not retry Unknown work. Ctrl-C/SIGTERM during the owning run signals cancellation and waits for owned cleanup, then prints the retained partial result and exits nonzero. An accepted cancel is not proof that billing stopped, and readonly inspection is not second-process cancellation IPC.

### Standalone scoped HTTP scan

`scan` runs one durable HTTP investigation without Node, a shell tool, or a container. Select an explicit public scan profile alongside existing provider and private HTTP configurations:

```sh
0sec-native --state state.db --scan-profiles scans.json --providers providers.json --http-profiles http.json scan --target https://example.test/app/ --profile review --command-id scan-1 --format json
0sec-native --state state.db scan show --scan SCAN_ID
0sec-native --state state.db scan list --limit 20
0sec-native --state state.db scan report --scan SCAN_ID --format markdown
```

Example `scans.json` (these rates must be declared in matching provider profiles):

```json
{
  "review": {
    "schema_version": 1,
    "kind": "scoped_http",
    "provider": "reviewer",
    "model": "configured-model",
    "instructions": "Investigate only the authorized HTTP scope and cite retained evidence.",
    "http_profile": "target",
    "budget_limit": 1000000,
    "currency": "usd",
    "reservation_per_turn": 100000,
    "max_turns": 8,
    "max_hypotheses": 8,
    "deadline_ms": 600000
  }
}
```

`currency: "usd"` explicitly declares that captured provider rates and budget units are **micro-USD**. `currency: "units"` makes no dollar claim. Charged model usage and unresolved holds remain separate; reservations limit admissions, not a provider's eventual invoice. HTTP request counts, request-body bytes, charged response bytes and held response bytes come from the complete original account ledger, independently of the displayed evidence prefix. Optional `context_policy`, `delegation_policy` and `web_experiment_policy` use their existing strict bounded schemas. Delegates share the original model budget and HTTP account and can only receive HTTP or authorized experiment tools. Profiles contain no credentials. Target authentication stays in the named HTTP client's private environment references and host-managed revision.

The target must already be allowed by the captured HTTP policy. It never changes the base URL, allowed hosts/paths, auth origin, redirects or rate limits. The agent chooses requests, experiments, delegation and stopping within those bounds. This initial route has no target shorthand, browser, MCP, package/source translation, shell/plugin execution, strategy activation or interactive question/approval waiters. Unknown profile keys and unsupported flags fail explicitly.

Fresh admission atomically binds the scan, its session, actual actor/controller and original HTTP account before effects. The deadline is absolute from that admission; cancellation closes new admissions and drains owned work. SIGINT/SIGTERM prints the retained partial result after cleanup and exits 130/143. Holds can remain when actual usage is unknown. An accepted cancellation request is not evidence that all work has stopped. Restart does not resume Unknown work or refill the account.

A real structured submission, including an empty one, is distinct from stopping with prose, reaching a turn/budget/deadline limit, failure or owner loss. Hypotheses remain **Unverified**, severities are **claimed**, and the security conclusion is **not established**. Empty hypotheses do not establish safety. Triage acceptance and matching experiment predictions do not verify a vulnerability. Native exits are 0 for a completed workflow, 1 for completed work with claimed critical/high hypotheses (an unverified CI severity policy), 4 for a causally established budget stop, and 2 for incomplete/error/report-publication outcomes. Successful read-only commands exit 0 regardless of the underlying scan disposition.

Investigation and report publication have separate retained outcomes. Canonical reports are limited to 8 MiB; `report_too_large` preserves the compact outcome and evidence links rather than silently truncating findings or rerunning the actor. Reports identify any truncated observation inventory and its actual next cursor. Use existing `web observations`, `web evidence`, `web range` and findings commands with the retained session/root IDs for bounded follow-up inspection. Report export never dispatches another request.

Exact command retries compare original target/profile identity and return retained work before loading even explicitly supplied deleted configuration files. Changed target/profile conflicts. Active duplicates return a snapshot; no second scan is started. `show`, `list` and `report` work without engine ownership, recovery, migration or current configuration. Follow the actual list cursor even when a bounded page is empty.

Output is terminal text, one native JSON document, Markdown (`md` alias), or inert HTML. These are native scan records, not legacy managed-worker reports. `0SEC_CLOUD_*`, `0SEC_EMIT_RESULT_LINE`, `0SEC_REPORT_PATH` and legacy target-auth environment variables do not automatically enable uploads, result markers, file writes or scope/auth overrides. This command does not claim managed `http_audit` compatibility; that requires a separately qualified controller/consumer adapter.

### Native history and timeline exports

`history` browses the current native database's standalone and managed HTTP
scans, newest admission first. It shows exact scan/session IDs, retained lifecycle,
observation time and sequence, model charges and holds, HTTP byte holds,
unverified claim counts and report publication state. An unavailable terminal
result has an unavailable count, never an invented zero. `--kind http` is the
unchanged default. `--kind review` selects the separate local-review index,
including running, stopped and Unknown reviews. It retains original input,
snapshot identity, workspace-selection receipt, exact exclusion rules, model
charges/holds and read freshness. Legacy captures without a selection receipt
explicitly leave original workspace scope unrecorded. Other agent sessions are
not included in these workflow indexes.

```sh
0sec-native --state state.db history --limit 10
0sec-native --state state.db history --before-sequence CURSOR --format json
0sec-native --state state.db history --kind review --limit 10
0sec-native --state state.db history --kind review --before-sequence CURSOR --format json
0sec-native --state state.db timeline SCAN_ID --format markdown
0sec-native --state state.db timeline --session SESSION_ID --format json
0sec-native --state state.db timeline --session SESSION_ID --after-sequence CURSOR --format csv
```

These commands use read-only native storage while an engine owns the database.
They do not load provider, sandbox, HTTP or harness configuration, create state,
recover an epoch, dispatch work, or read a legacy TypeScript database. History
HTTP JSON reuses the `scans` reply/page contract. Review JSON has
`schema_version:1`, `kind:"review"` and `page:{reviews,next_before_sequence}`;
each review entry is metadata, without model result text or source/archive
bodies. Use `review report --review ID` for retained claims. Both indexes follow
`next_before_sequence` until null, with independent admission-sequence cursors
and limits of 1–32 entries. Do not reuse a cursor between kinds. Review reads
validate original admission/lifecycle/budget witnesses under one read snapshot,
with a shared 64 MiB evidence budget and a 1 MiB encoded page cap; byte limits can
shorten a page. A corrupt entry fails explicitly, and a missing projection is not
silently treated as empty history. Successful lifecycle never implies zero claims
or a verified vulnerability.

Timeline accepts one exact scan or session identity and returns up to 100 events
in durable sequence order, with a 4 MiB retained payload read budget. Oversized
rows fail explicitly. JSON preserves each event's full retained payload; it is
not a generic secret-redaction service. Human exports show bounded, escaped
summaries and disclose omitted payload fields. CSV cells are quoted and protected
against spreadsheet formula interpretation. The last exported sequence is the
next cursor (also `next_after_sequence` in JSON); continue until an empty page.
An active session can append more events after any read. The native journal does
not record per-event wall-clock timestamps or MITRE ATT&CK/ATLAS labels, so these
exports do not invent them or claim legacy forensic-timeline parity.

Neither command replays effects or implies vulnerability verification. The
legacy `history` multi-database discovery and timeline time/taxonomy filters
remain unsupported. Explicit native `--state` selects one database. Read workers
are drained after signals or a five-second read deadline; output also has a
five-second deadline. Existing SQLite/host I/O completion can delay a drained read.

Executable acceptance lives in `tests/history.rs`, `tests/review_history.rs` and `tests/timeline.rs`: real
loopback scans, partial/cancelled usage holds, offline pagination after deleting
configuration, live-owner reads, untrusted formatting, missing state and bounded
oversized-row refusal. These fixtures do not qualify a paid provider or deployment.

### Explicit managed HTTP invocation

`managed-http` is a separate native worker contract, `0sec-native-http/v1`:

```sh
0sec-native --state /private/run/state.db \
  --providers /private/run/providers.json \
  --http-profiles /private/run/http.json \
  managed-http --grant /private/run/grant.json --report /private/run/terminal.json
```

The controller supplies a strict `ManagedScanGrant`: cloud scan, organization and
unique dispatch UUIDs; grant revision and expiry; normalized target; named scan
profile and its full public policy; exact normalized HTTP policy/auth revision;
and public provider endpoint, wire and rate pins. Credential values remain in the
existing private provider/HTTP loaders. On Unix the grant must be a regular,
non-symlink file owned by the current user with no group/other permissions (normally
`0600`). The report parent directory must already exist. Runtime/profile overrides
outside the grant are rejected; grant/configuration files and native state cannot
be used as report destinations. Help does not load grants or acquire state.

The command runs the existing scan controller and waits for cancellation cleanup.
It atomically writes the bounded native terminal file before emitting exactly one
`0SEC_NATIVE_RESULT={...}` metadata line containing the file's byte count and hash.
The marker is neither a report nor a clean-completion assertion. Publication errors
emit no marker and leave the investigation's retained result unchanged. A subsequent
exact invocation can retry publication without another provider or target request.
The file preserves partial/Unknown outcomes, cancellation/deadline intent, original
model and HTTP holds, claimed severity and `Unverified` hypotheses. Unmeasured
HTTP enforcement statistics are explicitly unavailable, never fabricated zeros.
If full retained evidence cannot be validated or read within its bounds, the file
instead records unavailable publication, preserving the separately validated
outcome and original publication reference; the command exits `2`. Invalid grant
or accounting metadata still prevents publication entirely.

Retries compare the entire original durable grant before loading current provider
or HTTP configuration. They work after credentials/configuration are removed and
after the grant expires; they do not extend its original deadline or allowance.
An active duplicate does not publish a terminal file or cancel the owner. An exact
execution retry attempts the existing exclusive owner lock without loading
credentials: a live owner blocks it; after owner death, epoch recovery retains
Unknown work and holds without replay, then publishes the available terminal
metadata. Read-only `scan show/list/report` never perform this recovery. Signals
use the standalone scan's drain and exit behavior, including `143` for SIGTERM;
ordinary completed/claimed-high/partial/budget exits remain `0`/`1`/`2`/`4`.

No ambient cloud sink, legacy result/event framing, upload, target authentication
or report-path environment variable activates behavior here. The managed controller
remains responsible for reading, validating and publishing this **native** terminal
contract with a matching consumer. This command is not a replacement for legacy
`scan --mode http_audit`, a deployed worker image, or a verified security conclusion.

### Export a retained repair patch

```sh
0sec-native --state state.db source-repair-export \
  --session SESSION --operation SOURCE_REVIEW \
  --reproduction BASELINE_REPRODUCTION --repair REPAIR > candidate.patch
```

This read-only command reassesses the linked retained source, baseline, candidate,
and fresh reconstruction evidence. Only `validated_candidate_for_plan` can export.
It uses the complete retained preimage and replacement, so the original checkout,
provider credentials, and execution backend may be absent. It does not apply files,
run a model or executor, or mark a vulnerability verified/reportable.

Stdout contains only a full-file unified patch, with original line endings and
missing final newlines preserved. Validation errors produce no patch bytes and
exit nonzero. Missing retained preimages, binary content, and filenames containing
control characters, backslashes, or double quotes are rejected explicitly. Review
and apply the patch separately to a matching checkout; redirection may create an
empty output file when validation fails. Existing file modes are unchanged.

### Reproduce a retained native review claim

```sh
0sec-native --state state.db --docker-bin /path/to/docker \
  review reproduce --plan host-authorization.json --command-id verify-claim
```

The strict host-owned JSON envelope contains `schema_version: 1`, `review_id`,
`source_operation_id`, `archive_manifest_sha256`, `plan`, `deadline_ms` (1–3600000),
and `max_executions` (1–256). `plan` is the existing frozen verification plan:
exact retained snapshot/bundle/hypothesis identities, immutable backend, resource,
time and output limits, repeats, and independent attack/control cases. Exact
expected stdout/stderr are base64 strings. The case/repeat product must fit the
execution cap. No model chooses or receives this execution authorization.

The input file is limited to 1 MiB with a five-second read deadline. The engine
validates the retained review and restores its complete archive; the original
source and provider configuration may be absent. A fresh invocation accepts only
its plan and sandbox backend, rejecting provider and other runtime profiles.

Default output is the typed `SourceReproduction` JSON reply; `--format terminal`
prints a bounded summary. `ObservedForPlan` means the frozen expectations matched,
not that a vulnerability is verified or reportable. Complete observed/not-observed
assessments exit 0; partial, failed or unknown execution exits 2. SIGINT/SIGTERM
wait for owned cleanup and exit 130/143.

Reuse the command ID with the exact authorization file for an inert retained
retry, even with missing backend/configuration files. Changed authorization is a
conflict. Cached running/unknown results remain partial; a retry does not restart
cases or claim completion. Native execution grants no model budget and does not
reopen the original review session.

Inspect independently reassessed retained evidence without a plan file, source,
configuration, backend, or engine ownership:

```sh
0sec-native --state state.db review reproduction --command-id verify-claim
0sec-native --state state.db review reproduction --reproduction REPRODUCTION_ID --format terminal
```

Choose exactly one identity. Inspection works while the original owner is active;
running results show no completed assessment and exit 2. Terminal inspection uses
the same assessment and exit rules as execution, and rejects damaged retained
evidence. It does not resume cases or change the original review's claims.
