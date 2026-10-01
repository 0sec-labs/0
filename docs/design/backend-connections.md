# One frontend, multiple execution backends

Status: implemented over the shared workflow runtime, with local two-engine
HTTP lifecycle tests and live browser qualification. The connection contract,
backend namespaces, trusted registration, authenticated proxy, and remote workflow
adapters follow the boundaries below. This evidence does not qualify external
providers, remote operating systems, public internet deployments, or a generic
independent remote executor.

## What Codex actually separates

Inspected the public OpenAI Codex Rust repository at commit
[`236be1ad9f6169269bbad436a0eca41d21948680`](https://github.com/openai/codex/tree/236be1ad9f6169269bbad436a0eca41d21948680).
The desktop UI shown in the reference image is not in this public Rust tree.
The source proves a shared frontend/backend contract, not that the proprietary
desktop UI simultaneously multiplexes an arbitrary number of backends.

| Boundary | Evidence in the Rust implementation |
|---|---|
| Shared client facade | [`AppServerClient`](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server-client/src/lib.rs#L340) selects in-process or remote implementations. The same request, notification, approval-response, event, and shutdown methods dispatch through either variant. |
| Local execution without a second protocol | [Client README](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server-client/README.md#L28) describes typed in-process channels retaining the app-server response contract. Local execution does not require a separate UI-specific engine API. |
| Remote transport | [`remote.rs`](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server-client/src/remote.rs#L73) defines WebSocket and Unix-socket endpoints, authentication, initialization, correlated requests, and disconnection events. |
| A frontend using either implementation | [TUI construction](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/tui/src/lib.rs#L495) creates a remote app-server client; the same module also starts the in-process client. |
| Backend-owned filesystem semantics | [`AppServerPath`](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server-client/src/path.rs#L1) and the client platform/home accessors describe the connected server's paths and platform. A remote path is not a laptop path. |
| Model selection versus execution selection | [Thread parameters](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62) separately carry model/provider, working directory, and sticky environments. [Turn parameters](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L193) can override the environment. |
| Tool execution environment | [`EnvironmentManager`](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/exec-server/src/environment.rs#L73) manages concrete local and remote process/filesystem environments. Connecting the frontend to a remote harness is distinct from giving a harness a remote executor. |
| Approval and event routing | [Outgoing messages](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server/src/outgoing_message.rs#L116) distinguish directed connections and broadcasts, correlate server requests, and route thread messages to subscribers. [Thread state](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server/src/thread_state.rs#L316) tracks connection subscriptions. |
| Backend-owned history | [Thread manager](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/core/src/thread_manager.rs#L1205) resumes persisted rollouts; rendering and transport do not own the execution history. |

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes initialization, typed schema generation, bidirectional approval requests,
stdio/Unix-socket/WebSocket transports, and bounded request ingress. Its WebSocket
surface is labeled experimental. We should adopt the separation and lifecycle
semantics while qualifying our own transport and authentication.

The optional outbound Code Mode host is another boundary, distinct from the
inbound app-server listener. Transport descriptions differ between the fetched
documentation and this pinned source: the source's
[`code_mode_host.rs`](https://github.com/openai/codex/blob/236be1ad9f6169269bbad436a0eca41d21948680/codex-rs/app-server/src/code_mode_host.rs#L21)
uses an optional HTTP(S)/gRPC provider. Do not treat a documentation flag as proof
of a transport implemented in a different release.

## Baseline before connection routing

The dashboard originally had a single same-origin engine. `packages/dashboard/src/api.ts`
owns the local control token and HTTP transport. `packages/dashboard/src/lib/event-stream.ts`
owns authenticated SSE. `packages/dashboard/src/console/use-console-workspace.ts`
polls session snapshots and events. `packages/cli/src/commands/dashboard.ts`
constructs one gateway, workflow service, operator service, and scheduler against
local stores.

`packages/shared/src/desktop-console.ts` already supplies versioned snapshots and
events. `packages/core/src/workflow-runner.ts` supplies transport-independent typed
execution. These are the foundations to reuse. `packages/cli/src/web/console-gateway.ts`
currently couples local paths, account/runtime selection, approval decisions, and
session execution. Its checks belong to the engine performing the work.

The workbench bridge is a host/guest execution controller, not a general frontend
connection transport. Its SmolVM CLI bridge does not forward bidirectional stdin,
so it cannot carry MCP stdio. A remote engine connection should have an actual
request/event/approval protocol rather than reuse output capture as a connection.

## Execution architecture

```mermaid
flowchart LR
  UI[Dashboard / TUI / CLI / MCP client] --> Client[Backend-bound client]
  Client --> Registry[Registered backend connections]
  Registry --> Local[Local engine adapter]
  Registry --> Remote[Authenticated remote transport]
  Local --> Service[Session and workflow services]
  Remote --> RemoteService[Remote session and workflow services]
  Service --> LocalEnvironment[Local workspace / SmolVM / qualified runner]
  RemoteService --> RemoteEnvironment[Remote workspace / worktree / qualified runner]
```

Keep four independent selections:

| Selection | Meaning |
|---|---|
| Backend connection | The engine that owns sessions, runs, approvals, and retained results. |
| Workspace | A repository/directory/worktree on that engine, identified in that engine's namespace. |
| Execution environment | The engine's admitted local, SmolVM, container, or other qualified runner. |
| Model connection | The engine's configured provider/account/model. |

The composer can show backend and workspace beside branch/worktree controls,
while model selection remains separate. The screenshot is a useful interaction
reference, not evidence that a model dropdown selects an execution machine.

Define a `BackendDescriptor` with stable ID, display name, transport type,
connection status, protocol version, and advertised capabilities. Authentication
uses a credential reference owned by the trusted connection service; descriptors
and browser persistence do not contain provider keys or remote bearer secrets.

A `BackendClient` exposes typed request and event-subscription methods. Each
instance is permanently bound to one backend ID. Start with a local adapter over
the existing HTTP/SSE API. Keep UI code dependent on this contract rather than
introducing backend-specific execution branches into components.

Session, workspace, run, schedule, artifact, and approval references must include
`backendId`. React Query keys, saved drafts, navigation, and event cursors use the
same namespace. Selecting another backend changes which resources are displayed;
it does not move an active run, reuse its approval, or reinterpret its workspace.

## Implementation sequence

1. Add the backend descriptor/capability handshake and local `BackendClient`.
   Convert existing API call sites to the client while preserving local behavior.
2. Namespace caches, navigation, drafts, and resource references. Prove two engines
   with identical local session/run IDs cannot collide or receive each other's
   commands, results, or approvals.
3. Add explicitly registered connections through a local trusted proxy. Initially
   reach remote loopback engines through SSH tunnels. Keep the browser same-origin;
   do not let `webFetch` send control credentials to arbitrary supplied URLs.
4. Make workspace listing/selection and file access backend-owned. Bind every
   session and run to its chosen workspace, environment, and model connection.
5. Qualify direct authenticated remote transport: TLS, version negotiation,
   bounded ingress, request IDs, idempotency, event cursor replay, reconnect, and
   connection-specific approval routing. Preserve server-side scope and action
   checks. Add a backend selector only when the underlying isolation works.
6. Support independently deployed remote engines using their existing admitted
   local or SmolVM executors. An independently registered remote executor is a
   separate future capability; this connection API does not qualify or expose one.

## Operator and transport contract

The trusted local registry is a versioned file containing backend ID, display
name, engine URL, and an environment variable reference for that engine's bearer
credential. The browser receives sanitized descriptors, never endpoints or token
bindings. Registration changes require editing the trusted configuration; the
browser cannot supply an arbitrary endpoint or credential.

The remote listener uses `0 web --engine-token-env NAME` with server-owned
`--engine-workspace`, `--engine-scope`, and optional `--engine-target` admission.
`--engine-allow-apply` admits explicit exact-candidate application; the request and
live proof gates still apply. `--engine-time-cap` and `--engine-cost-cap` constrain
caller limits (defaults ten minutes and $5). The local connection service uses
`0 web --backends-config PATH`. The remote bearer credential is
separate from the per-browser control token. Registered URLs admit HTTPS or HTTP
loopback tunnels. The protocol handshake is `GET /api/backend/handshake` and reports
version, engine identity, platform, capabilities, and an optional connection epoch.
The browser remains same-origin through registered proxy routes. Configuration may
pin `expectedEngineId`; otherwise the registry pins its first accepted identity
for its process lifetime. A mismatching identity is incompatible. The optional
server instance epoch distinguishes a process restart from a different engine.

CLI workflow/history commands and the MCP workflow adapter accept a configured
backend ID. Targets, workspace references, inputs, provider selection, and database
references resolve on that engine. Remote routing does not construct a local model
runtime or reinterpret a server path on the laptop. Remote patch permissions are
still checked by the owning engine; a client's local flag cannot broaden server
admission.

See `docs/src/content/docs/engine-connections.md` for the actual operator setup.

## Required lifecycle semantics

The engine owns run state and history. Losing a UI connection means disconnected,
not completed or cancelled. Reconnect reads an authoritative snapshot and replays
events after the acknowledged cursor. Cancellation targets the owning backend and
requires acknowledgement; a stale local status does not prove that work stopped.

Approval requests carry backend/session/run/request identity and a scope/operation
digest. Responses return to that exact owning connection and request. Model or
workspace changes cannot silently transfer pending approvals. Existing target
authorization, candidate proof, provider-usage accounting, and filesystem gates
remain enforced on the execution engine.

Local foreground CLI and stdio MCP hosts retain ownership of their local runs.
A remote client is a connection to an independently running engine: disposing its
transport detaches that client, while an explicit cancellation request targets the
engine-owned run. Foreground remote CLI Ctrl-C sends an explicit cancellation
request; closing an MCP adapter or proxy does not. The remote engine retains
authoritative state and enforces its own shutdown and executor cleanup. A network connection does not add crash-safe
replay, automatic recovery, or a generic persistent remote executor.

## Acceptance checks

- The same UI can select two registered engines without cache/draft/ID collisions.
- Closing and reconnecting the frontend preserves engine-owned run history.
- Disconnect, cancellation requested, cancellation acknowledged, and completion
  appear as distinct states.
- Remote paths are resolved by the remote engine; laptop paths are not guessed or
  rewritten from prose.
- Provider and connection credentials remain with their owning engine/connection
  service; switching backend cannot forward an unrelated account.
- An approval from engine A cannot authorize a request on engine B.
- Unsupported capabilities fail before dispatch; existing local workflows and
  SmolVM restrictions continue to work through the local adapter.


## Qualification evidence and remaining boundary

- The shared protocol validates version/capability negotiation and backend-bound
  resource, request, approval, and event-cursor identities. Its unit tests cover
  identical resource IDs on different engines and reject secret-bearing browser
  descriptors.
- The frontend uses permanently bound clients, backend URL namespaces, separate
  query clients, and backend-scoped persistent drafts. Switching engines disposes
  the previous view rather than changing the destination of its pending requests.
  Handshake epoch/capability changes require a fresh view and authoritative snapshot.
  Live production-console checks switched local and remote engines and confirmed
  separate drafts, settings, and sessions. Development StrictMode switching was
  also checked against the running local listener.
- The trusted registry validates configured endpoints, keeps bearer values out of
  public descriptors, rejects unsupported API routes/capabilities before dispatch,
  pins engine identity, and bounds configuration, requests, and responses. Remote
  event proxies forward the acknowledged SSE cursor. Remote client fixtures check
  engine-native paths, admission errors, capability rejection, and transport-only
  disposal. The registry's hostile-input tests cover endpoint and route admission,
  identity pinning, credential isolation, limits, and cursor forwarding.
- `packages/cli/src/backend-integration.test.ts` uses actual HTTP listeners,
  registry, core runner, control store, and workflow engine service, with only the
  assessment implementation substituted. It checks equal workflow IDs on distinct
  engines, detach/reconnect while a run stays active, rejection of another engine's
  results/cancellation, and retained results after engine-service restart. A separate
  case confirms cancellation acknowledgement leaves the run `running` until
  assessment abort cleanup finishes, then retains partial findings as `cancelled`.
- A live two-engine smoke check confirmed distinct handshake identities, equal
  workflow IDs with distinct definitions, separate remote sessions, and remote CLI
  template discovery. These checks establish transport and ownership behavior on
  the local qualification host; they do not demonstrate a real external provider
  assessment, a different remote operating system, or an internet deployment.
- HTTP loopback tunnel setup is the operator baseline. HTTPS endpoint admission
  is not a generic remote-executor qualification. A separately deployed engine
  still has to provide the compatible authenticated control API and its own runner
  prerequisites.
- A local engine using an independently registered remote executor remains future
  work. No component in this rollout treats an MCP endpoint, model API, output-only
  workbench bridge, or arbitrary SSH command as such an executor.
