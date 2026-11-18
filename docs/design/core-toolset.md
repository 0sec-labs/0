# Core toolset

Status: implemented for Threads and Agents (console); scans keep `full`. Updated 2026-11-17: the registry is cut to nine tools.
Owner decision (Doruk): narrow the tool list a lot, bash first, Pi style, clean up.
Principles: [tool-philosophy.md](tool-philosophy.md). Skills: [skills-as-the-unit.md](skills-as-the-unit.md)
(packs here are the `tools:` allow-list ceiling of section 8 there; `core` and `pack:<name>`
spellings are accepted in a skill's `tools:`).

## 1. Result

Eight tools: `bash`, `str_replace`, `finding`, `ask_operator`, `load_skill`, `web_search`,
`spawn_agent` and `memory` (when Memory is on). Files are read through the shell. `str_replace`
creates a file when `old_string` is empty. A reply with no tool call ends the turn.

Selection: `toolset: "core" | "full"`; explicit value, then `ZERO_TOOLSET`, then the surface
default (`core` console, `full` scans and explicit tool overrides). Hidden flag
`--toolset core|full`. Code: `packages/engine/src/agent/toolset.ts`, wiring in
`console/turn-engine/session.ts`.

## 3. Safety with the shell as the main action tool

Where each boundary is enforced (read from code, then tested through the real console
dispatch in `packages/engine/src/console/core-toolset-safety.test.ts`):

| Boundary | Enforced in | Does it depend on parsing shell text? |
|---|---|---|
| Budget and sandbox | Cost ceiling and time caps stop a run; the optional container executor (SmolVM or Docker) isolates commands from the host | No |
| Ask before running commands | `executionPolicy` plus the per-action approval gate: every effectful call, `bash` included, is put to the operator and does not run unless approved | No |

Tests (all pass): ask-first runs nothing the operator declines and runs it after approval.

Decision on the classifier: I did not build a read-only shell, and since 2026-11-15 there is no
Read-only mode at all (one mode: shell access). A text allowlist cannot be made reliable
(`find -exec`, `awk system()`, `git -c`, `sed w`, `xargs`, `env` are all "read" commands that
write), so the limits are budget, the sandbox and Ask before running commands.

### Gaps I could not close

1. **The shell runs on the host** unless an execution profile selects a sandbox.
   File writes by `bash` are not confined to the granted folder by anything but the approval
   gate (`ask`) and the operator's trust; `apply_patch` and `str_replace` are confined, `bash`
   is not.
2. *(Closed 2026-11-15.)* Read-only Threads could not call `save_finding`. Read-only is removed,
   so every Thread and Agent can record findings.

## 4. A/B evidence

What was run, and what was not.

**Not run: XBOW (the 12-challenge subset).** There is no XBOW checkout on this host (and no
network access to fetch and build one here), and the XBOW runners call `agenticScan`, which
does not go through the console turn engine. Its web roles already use a shell-first list
(`agentic/phase-runners.ts`). So an XBOW run would not exercise the `core`/`full` switch at all.
Scans stay on `full` and nothing here is a claim about them.

**Run: the workflow-hardening class, through the 0 CLI and a headless engine** (`threads start`
against `0 web --headless`, model gpt-6-luna, effort medium, shell access, cost
ceiling 0.25 USD per thread). Eight repos from the earlier fix experiment, two attempts each,
two arms (`ZERO_TOOLSET=core` and `=full`), 16 runs per arm, identical prompt (it asks to
triage zizmor findings and pin actions, narrow permissions, move template injections to env).
One fresh engine process per run (see the note on engine failures below).

Pass = a patch exists, the in-scope zizmor classes (unpinned-uses, excessive-permissions,
template-injection, artipacked) are gone after applying it, and every pinned SHA matches
`git ls-remote` for the tag in its comment. This is the harness-side check, not the agent's claim.
zizmor and the SHA check, not a reviewer, decided; nothing was executed.

| Arm | Pass | Wilson 95% | Mean cost / run | Mean input tokens / run | Mean tool calls | Mean model turns | Finished (end_turn) |
|---|---|---|---|---|---|---|---|
| core | 9 / 16 | 33% to 77% | USD 0.0069 | 207k | 23.1 | 14.3 | 16 / 16 |
| full | 8 / 16 | 28% to 72% | USD 0.0081 | 271k | 23.8 | 16.6 | 16 / 16 |

Per repo the outcome is the same in both arms (color 2/2, execa 2/2, just 2/2, semver 2/2 pass;
gson 0/2, rack-attack 0/2, yq 0/2 fail) except fd, where core passed once and full never. The
shared failures are task limits, not tool limits: gson produced no patch in either arm,
rack-attack leaves `ruby/setup-ruby@v1` (a branch), yq leaves self-referencing `@master` pins.

Reading: N is 16 per arm on 8 repos, so the intervals are about 40 points wide. This detects a
large loss and cannot show equivalence. There is **no evidence of a regression** and a
directional saving: about 24% fewer input tokens and 15% lower cost per run, same tool calls,
slightly fewer turns. The full arm spent 58 calls on `update_todos` across 16 runs (core has none,
and used `done` in 15/16 runs against 6/16 in full). Spend for the whole experiment including
failed attempts and probes was about USD 0.47 (engine-estimated) of the USD 15 cap.

Skill loading: `load_skill` was called in 3 of 16 core runs (4 calls). None of these tasks needed
a pack, so the packs were not exercised end to end against a model; pack loading is covered only by
the unit tests. Skills alone are often never invoked, so must-know rules belong in the system
prompt, not only in a skill.

Other measured fact: on a trivial prompt the first request is 5,145 input tokens (core) against
6,873 (full): the system prompt is most of what is left, about 4k tokens, and is the next thing to cut.

### Decision

Keep `core` as the default for Threads and Agents (the owner decided; the data does not argue
against it). Scans keep `full` until `web-pentest` is wrapped as a pipeline skill and an XBOW A/B passes
(skills-as-the-unit.md section 8.4). Not measured: a stronger model, other task classes
(web, source review, fix with tests), pack-using tasks. Do not read this as proof for other work.

### Engine failure seen during the A/B (resolved)

Cause: under Node, global `fetch` negotiates HTTP/2 and keeps one multiplexed TLS session per
origin. After concurrent large inference requests the provider closed it with a TLS `bad_record_mac`
alert (`ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC`, `http2ErrorCode` 2) and every later call reused the
dead session, failing instantly with `fetch failed`. The code was reported as `unknown` because it
contains a `/` and the classifier only accepted `[A-Za-z0-9_]`. It is not tool-list specific; the core
arm only hit it sooner because it ran more requests per minute. Fix: model calls use a dedicated
HTTP/1.1 dispatcher recreated after any connection failure (`runtime/llm-api/transport.ts`), the cause
code is shown, and `/healthz` reports the failure counters.

That first fix did not actually take effect, and the failure came back after about 50 turns of one
console process (every call failing with `bad_record_mac` until restart; `failedCalls` and `recycles`
both 102). Reproducer: 4 parallel 100-150KB POSTs per turn through `modelFetch` against the real API.
Findings:

- Node 24+/26 bundle undici 8 and keep the real global Agent under `undici.globalDispatcher.2`; `.1`
  is a `Dispatcher1Wrapper`. The transport read only `.1`, found no `Agent`, and installed no
  dispatcher, so calls still shared one HTTP/2 session and a "recycle" only incremented a counter.
  The unfixed transport failed with `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC` at turn 11 and then
  `ERR_HTTP2_INVALID_SESSION` on every call.
- The compiled binary runs under Bun, whose fetch ignores `dispatcher`; its keep-alive pool was never
  dropped either. Bun gets `keepalive: false` (one connection per request).
- TLS session resumption was ruled out: sessions were never reused (`isSessionReused()` false on
  every connection). Resumption is nevertheless disabled and every dispatcher gets its own
  `SecureContext`, so nothing can carry across a recycle.
- undici can report a TLS alert on an HTTP/1.1 socket only as "other side closed"; the transport keeps
  the socket's own error code so `/healthz` `modelTransport.lastFailureCode` names it, and reports
  `lastSessionReused`.
- A recycle closes the old pool (healthy in-flight siblings finish) and destroys it 30 seconds later.
  Failed calls are still not replayed unless the existing policy proves the request was not sent
  (now including TLS errors on a connection that wrote 0 bytes).
