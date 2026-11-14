---
title: Console
description: Browser conversations and headless chat automation for the 0 engine.
---

## Browser conversations

Run `0` or `0 web` to open the account-free browser console under Node or the
standalone binary. Choose a workspace folder, connect a provider in
**Connections**, and choose the conversation model and autonomy mode.
Use **Chat**, **Findings**, **Automations**, **Plugins** and **Learning** for
investigation, evidence review and reusable capabilities.

The interactive terminal UI and readline chat REPL are removed. `0 console`
without a headless prompt prints browser guidance.
The CLI still supports scans, source reviews, binary research, automation and
MCP integrations. Retained terminal modules supply shared chat/settings
helpers; they do not provide an interactive terminal entrypoint.

## What Memory remembers

The conversation history supplies context within a chat. Saved findings retain
investigation evidence. **Memory → Lessons** is a separate library of reusable,
source-backed project notes; it is not a list of sources used by a particular reply.

During source inspection, the agent can save a concise lesson with
`remember_codebase`. Each lesson records its project directory, supporting file
paths and content fingerprints. Browser conversations with codebase learning
reuse eligible lessons for the authorized directory, checking file contents before
each model request. Changed or missing supporting files exclude a lesson from recall.
A completed chat alone does not become a source lesson.

Open a lesson's **Supporting files** to inspect its evidence. **Stop using** marks
the retained lesson disabled; it keeps the record for inspection. Lessons are hints
to check against source code, not verified findings or permission to execute tools.
The chat inspector shows lessons supplied with the latest model request. This
means the model received them as context; it does not establish that the answer
relied on or cited them. Older engine versions may not provide this information.

Source notes live in the engine's private user-state store, outside the repository,
and can be mirrored into the learning database shown by Memory. Recalled notes
are sent to the selected model as request context. In browser conversations they
are added temporarily rather than copied into saved chat history. Set
`ZERO_DISABLE_HUNT_MEMORY=1` on the engine to disable source-note learning and recall.

Source-note mutations take a local writer lock and reload the log before writing,
so cooperating processes cannot compact away each other’s notes. Lock contention
fails immediately. A process killed while holding the lock can leave a lock
directory behind; confirm no writer is active before manually recovering it.


## Headless prompts

To continue an existing browser chat from the CLI, use its live chat
ID and the same engine:

```bash
0 console --session <session-id> --print "Summarize the retained findings" --format json
0 console --session <session-id> --backend staging --print "Continue the investigation" --format ndjson
```

Attached chat keeps the chat's configuration and reports pending
decisions without approving them. JSON prints one result; NDJSON prints engine
events followed by that result. Open **Runs** to inspect linked automation
executions, scan reports and findings. See [Engine Connections](/engine-connections/#continue-the-same-work-across-interfaces)
for shared run references and lifecycle behavior.

Run one request and exit:

```bash
0 console --print "Review the selected repository" --mode standard
0 console --print "Review the selected repository" --mode standard
0 -p "Review the selected repository" --mode standard
printf '%s' 'Summarize the selected findings' | 0 console --print --mode standard
```

These paths use the engine's tool registry and stream ordinary text results.
`--model`, `--role`, `--target`, `--scope`, `--finding`, `--max-tool-calls` and
`--db-path` configure the headless run. Run `0 console --help` for current options.
A provider connection is independent of target authorization and tool isolation.

## Saved chats

Combine a prompt with a saved chat id or unique prefix:

```bash
0 console --resume SESSION_ID --print "Continue the investigation" --mode standard
0 console --continue --print "Summarize the evidence" --mode standard
```

Saved-chat model and target are used when available. A bare `--resume` has
no terminal picker; use the browser history or supply a chat id.

## Agent control of a running web backend

The dedicated CLI commands do not cover every web operation. `0 api` provides a
JSON/text client for the same admitted backend HTTP APIs, with the engine's
existing authentication, capability and approval checks. It does not launch local
tools or bypass a selected execution profile. Browser-local appearance and
interactive OAuth approval are separate from backend control.

Start an explicitly authenticated local engine (keep the token in an environment
variable, never a command argument):

```bash
export ZERO_AGENT_TOKEN="$(openssl rand -hex 32)"
0 web --no-open --port 48123 --engine-token-env ZERO_AGENT_TOKEN --ready-json
```

From another process with the same token environment:

```bash
# Discover the selected engine and its advertised capabilities.
0 api --engine-url http://127.0.0.1:48123 --engine-token-env ZERO_AGENT_TOKEN

# Inspect chats without sending a model prompt.
0 api /api/console/sessions --engine-url http://127.0.0.1:48123 --engine-token-env ZERO_AGENT_TOKEN

# Create an idle chat using a JSON file; the server validates its contents.
0 api /api/console/sessions --method POST --data @session.json --engine-url http://127.0.0.1:48123 --engine-token-env ZERO_AGENT_TOKEN
```

Alternatively select `--backend <id>` and optional `--backends-config <file>` to
use an operator-registered HTTP engine. Direct attachment and registered selection
cannot be combined. The default method is GET; writes require an explicit method
and may still require server approval. JSON input files must be regular files of
at most 1 MB.

Responses use `{ "ok": true, "status": 200, "data": ... }`. HTTP failures return
`ok:false` and a nonzero exit; validation/transport failures write a JSON error to
stderr. Exit zero means the request succeeded, not that a queued operation has
finished. Inspect returned status/IDs, poll the matching resource, and cancel it
explicitly when needed. Unsupported routes, redirects and missing capabilities
fail rather than falling back to local execution. Text exports are returned as
strings; this command is not a binary-download or event-stream client.

Use a freshly built CLI when testing unreleased commands. The repository's
`scripts/0dev.sh` rebuilds workspace dependencies before invoking the development
entry point; an installed standalone executable does not change when source files
are edited.

## Local history and memory backend

Browser search and the agent's conversation-history tools share the same local
conversation search service. Both search conversational text and metadata using
all query terms, rank relevant matches ahead of recency, and omit tool payloads
and private reasoning. Agent discovery stays in the current project unless
explicitly widened. Bounded searches report when the saved library was truncated.

Chat, scan, and isolated-host source-lesson retrieval use the learning service's
shared recall policy: validate supporting files, respect disabled lessons, and
limit the returned context. Faithful transcripts remain separate from retrieved
hints so resume does not depend on an extracted summary.

This uses the storage already shipped with the engine. It does not require a
Mem0 server, vector database, embedding model, or a migration of existing chats.
Raw transcripts remain in the private session store; source notes and their
learning/evidence records keep their existing formats.

## Action modes

The browser offers **YOLO** (the default for new chats, without per-action
approval prompts) and **Standard** (ask before actions). Switching to YOLO also
resumes tool actions waiting for per-action approval. Scope and directory grants,
automation authorization, and questions remain separate decisions. Existing chats
keep their saved setting until you change it.

## Non-interactive approval limitations

Headless prompts have no interactive tool-approval surface. Requests requiring
human approval cannot be completed through a terminal dialog. Use the browser
conversation to review those actions. The default headless autonomy mode is
YOLO; when the scope plugin is active it requires configured in-scope entries.
Explicit restrictions remain in effect. `--mode standard` is available for a
headless run with the appropriate scope and tool policy.

## Execution and models

**Local** means tools execute on the engine host. Your selected model endpoint
can still be external. A VM execution profile and a model connection are separate
choices. Configure and inspect them in the browser before starting work.

See the [quick start](https://github.com/0sec-labs/0#quick-start), [provider connections](/api-keys/),
[scope](/scope/) and [engine connections](/engine-connections/).

## Model picker

Use the browser conversation model picker to select a provider/model. Worker-role
model overrides remain an embedding API capability. See [model routing](/configuration/#multi-model-role-routing).

## Web search

Web search is available by default. The agent chooses when to call `web_search`;
enabling it does not search automatically on every message. There is no separate
search mode or composer toggle. Autonomy modes still control action approvals.

The engine uses [Parallel's anonymous hosted search](https://parallel.ai/mcp),
with DuckDuckGo as a fallback.
Both receive the search query. Results include source links and snippets; they do
not establish that a page was read in full. The anonymous service has usage limits,
and the engine reports unavailable providers rather than treating a challenge or
failed request as an empty search. No search API key is required.

Set `ZERO_FEATURE_WEB_SEARCH=0` on the engine to disable search by default.
The session configuration API also retains `webSearchEnabled` for explicit
per-chat overrides; saved overrides remain in effect. This setting controls the
built-in search tool, not all network access.

## Acquiring public source

In YOLO, a standalone public HTTPS repository checkout can acquire source for
review without authorizing tests against the hosting service. Ask the chat to
acquire the repository, then inspect it in subsequent tool calls. Checkout
does not change engagement scope; configured exclusions and private-network
restrictions still apply. See [scope rules](/scope/#local-workflows-and-strict-scope-mode).

## Messaging while agents work

The browser defaults to **Send when done**. Sending a follow-up queues it for
when the current response finishes, preserving that response and its agents.
Pressing Enter in an empty composer does not interrupt work. Use **Send now**
on a queued message or explicitly select **Interrupt and send** to interrupt
the current response; cancellation also reaches children of a blocking
(`wait:true`) call. Session-owned background agents keep running. Use the agent
controls to stop one agent or drain all agents explicitly.

`spawn_agent` accepts one `task` or a `tasks` batch. In browser chats with
background result delivery, it returns immediately so the parent can keep
working; use `wait:true` when the parent needs the results first. Background
workers remain addressable through the browser's agent controls and enabled
messaging routes. Hosts without background delivery wait by default and reject
an explicit `wait:false`. Scope, model approvals and the shared usage limits
apply to every worker. These workers belong to the live chat; they do not
survive an engine restart.

Interactive workers have no default iteration cap or countdown prompt. They
continue until the assignment is complete, cancelled, blocked, or an explicitly
configured execution or monetary limit is reached. Model-facing delegation
schemas do not ask the model to choose an iteration budget.

Use the same tool with `op:"list"` to enumerate this coordinator's owned subtree,
including descendants, or `op:"get", agent_id:"..."` for one record. `op:"stop"`
drains an owned subtree; `op:"stop_all"` drains owned descendants. Foreign chats,
ancestors and the caller itself cannot be stopped. Counts distinguish live leases
(including queued, parked and stopping workers) from terminal records. `subtreeLive`
also includes active descendants of a completed parent; subtree cleanup is reported
drained only after all those leases release. The terminal cache retains the most recent 256 records, with owner-scoped eviction
counts. Completed ancestors with live descendants remain discoverable even after
cache eviction; `pendingAncestors` counts these separately from drained terminal
records. Live workers are never evicted.

Parallel source reviews can set `read_only:true` on the spawn call or individual
batch entries. This restricts the actual tool surface and is inherited by descendants;
workers cannot grant themselves shell, edit or executable-plugin access.
Write-capable workers hold one exclusive slot per shared checkout, including while
queued or parked, until cleanup drains. Conflicting admission or parent mutation
fails immediately rather than waiting on a child. Use the same list/stop operations
to inspect and release an owned writer, or give independent writers isolated checkouts.
The guard covers this owned tree's actual dispatch roots, not other engine chats,
operator shells or arbitrary escaped processes. Workspace hints do not grant new access.

Worker records include `workspace` and `localEffects`: dispatch attempts, tool names
and observed successful direct `str_replace` edits. A failed worker with a recorded
edit differs from one that never dispatched local execution, but zero observations
do not prove an unchanged filesystem. Completion, failure and cancellation remain
separate from effects; `effects` stays `unknown`. Inspect the checkout before integration.

To send a follow-up to the same directly owned background worker, call
`spawn_agent` with `agent_id` and `task`. This returns immediately. Follow-ups
cannot include a batch, shared context, worker configuration overrides or `wait:true`.

## Interrupted model connections

Interactive chat automatically reconnects a dropped planner connection using
its retained conversation and completed tool results. Incomplete function calls
are not executed, and completed tool actions are not replayed. Stop cancels the
reconnect wait. Unknown usage remains unavailable; an explicit token allowance
without a receipt still stops rather than assuming the failed request was free.
Tool, harness, authentication and permission failures do not use this reconnect
policy.

## Stopping a response

`0 chats cancel <id>` acknowledges a stop request. The chat reports
`cancelling` while active work and cleanup drain, and returns to `ready` only
after that turn finishes. Queued children of a blocking call do not start after
cancellation; independently running background agents have separate stop controls.

After 15 seconds, a still-draining chat publishes
`cancellation.phase: "timed_out"` with its original request/deadline timestamps.
This reporting deadline does not claim that work stopped or unlock another
turn in the same chat. The chat shows the delay and offers a new chat or
agent inspection; other chats remain usable. Inspect retained state with
`0 chats show <id>` or `0 chats events <id>`.

Qualified Bun chats on macOS/Linux expose `cancellation.forceStopAvailable`.
Use `0 chats force-stop <live-id>` to stop that chat's owned process and
registered resources while leaving the engine and other chats running. It
preserves interrupted history without replaying the tool; completed external
effects are not undone. Unconfirmed cleanup remains quarantined.

Cancellation remains cooperative for local in-process operations that ignore
their abort signal, including unsupported Node/WASM execution. These chats
do not advertise force stop. Isolated SmolVM turns retain their controller-stop
path.
