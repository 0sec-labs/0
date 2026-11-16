# Core toolset

Status: implemented for Threads and Agents (console); scans keep `full`.
Owner decision (Doruk): narrow the tool list a lot, bash first, Pi style, clean up.
Principles: [tool-philosophy.md](tool-philosophy.md). Skills: [skills-as-the-unit.md](skills-as-the-unit.md)
(packs here are the `tools:` allow-list ceiling of section 8 there; `core` and `pack:<name>`
spellings are accepted in a skill's `tools:`).

## 1. Result

| Default Thread tool list | Before | After |
|---|---|---|
| Registered tools | 76 | 76 (nothing deleted, see 4) |
| Eligible for the default role (audit, no scope) | 57 | 57 |
| Advertised on turn one | 19 (17 + `list_tools`, `load_tool`) | 11 |
| Reachable by `list_tools`/`load_tool` | about 40 specialist tools | none of the pack tools; only plugin, MCP and workflow-management tools |
| Reachable by a loaded skill | n/a | 18 packs, 55 tools, next turn |

The 11: `bash`, `read_file`, `list_files`, `search_files`, `str_replace`, `apply_patch`,
`save_finding`, `update_finding`, `ask_operator`, `load_skill`, `done`. `list_files` and
`search_files` stay as cheap, scope-confined ways to look around a repository. `apply_patch` (add/replace/delete) is also the write tool. In a console
that wires workflow tools, plugins or MCP servers, `list_tools` and `load_tool` still appear
for those, never for pack tools. The verifier gate is not a model tool.

Selection: `toolset: "core" | "full"`; explicit value, then `ZERO_TOOLSET`, then the surface
default (`core` console, `full` scans and explicit tool overrides). Hidden flag
`--toolset core|full`. Code: `packages/engine/src/agent/toolset.ts`, wiring in
`console/turn-engine/session.ts`, pack loading in `load_skill` (`agent/tools.ts`).
Only built-in skills can declare packs; a repository's folder skills cannot. A pack only
advertises tools the run's role, scope and feature gates already allow.

## 2. Inventory

Columns: callers are file counts for non-test source / test files / skill YAMLs / bench /
docs (derived by grep over tracked files, `node` script, 2026-11-15; usage counts from recorded
runs are not available in this workspace). Gate is how the default role set and dispatch
decide the tool today. Decision is core, `pack:<name>`, `merge-into:<tool>` or special.

| Tool | Gate | Callers (src/test/skill/bench/docs) | Decision | Rationale |
|---|---|---|---|---|
| `http_request` | network roles; scope + SSRF rail | undefined/undefined/0/0/5 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `send_prompt` | network roles | undefined/undefined/0/0/4 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `save_finding` | network + audit roles | undefined/undefined/5/0/6 | core | The deliverable; carries the verifier gate input. |
| `query_findings` | common set; read-only class | undefined/undefined/0/0/2 | pack:ledger | Specialist; reachable when a skill declares the pack. |
| `use_loot` | flag lootLedger | undefined/undefined/0/0/0 | pack:ledger | Specialist; reachable when a skill declares the pack. |
| `plan` | flag agentPlan | undefined/undefined/1/3/26 | pack:ledger | Specialist; reachable when a skill declares the pack. |
| `update_finding` | network + audit roles | undefined/undefined/0/0/3 | core | Revises a saved finding. |
| `read_file` | all roles; scope-confined | undefined/undefined/2/6/3 | core | Windowed, scope-confined read; cheaper than cat and safe in Read-only. |
| `list_files` | all roles; scope-confined | undefined/undefined/1/0/1 | core | Exploration path without the shell. |
| `search_files` | all roles; scope-confined | undefined/undefined/1/0/1 | core | Exploration path without the shell. |
| `str_replace` | file roles; scoped dir | undefined/undefined/0/0/0 | core | Exact-match edit; fails loudly. |
| `apply_patch` | file roles; scoped dir | undefined/undefined/0/0/3 | core | Add/replace/delete files and multi-file patches; this is also the write tool. |
| `run_command` | file roles; tokenised in ask mode, full shell in Changes | undefined/undefined/0/0/5 | merge-into:bash | Same capability as bash; kept dispatchable for stored sessions and workflows. |
| `update_target` | network roles | undefined/undefined/0/0/1 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `crawl` | network roles; passive recon | undefined/undefined/0/0/5 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `submit_form` | network roles | undefined/undefined/0/0/5 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `access_control_probe` | network roles; scope | undefined/undefined/0/0/0 | pack:access-control | Specialist; reachable when a skill declares the pack. |
| `access_control_workflow` | network roles; scope | undefined/undefined/0/0/1 | pack:access-control | Specialist; reachable when a skill declares the pack. |
| `access_control_cleanup` | network roles | undefined/undefined/0/0/0 | pack:access-control | Specialist; reachable when a skill declares the pack. |
| `bash` | network roles; scope + approvals at dispatch | undefined/undefined/3/13/37 | core | One shell for curl, jq, git, python, anything the model already knows. |
| `browser` | hasBrowser | undefined/undefined/3/3/42 | pack:browser | Specialist; reachable when a skill declares the pack. |
| `spawn_agent` | audit/network; worker policy | undefined/undefined/2/0/3 | pack:delegation | Specialist; reachable when a skill declares the pack. |
| `spawn_agents` | legacy delegation name; hidden from role sets | undefined/undefined/0/0/2 | merge-into:spawn_agent | Fan-out form of spawn_agent. |
| `spawn_persistent_agent` | legacy delegation name; hidden from role sets | undefined/undefined/0/0/0 | pack:delegation | Specialist; reachable when a skill declares the pack. |
| `monitor` | audit/network | undefined/undefined/0/0/1 | pack:delegation | Specialist; reachable when a skill declares the pack. |
| `web_search` | flag webSearch | undefined/undefined/0/0/1 | pack:intel | Specialist; reachable when a skill declares the pack. |
| `intel` | audit set + scoped-source set | undefined/undefined/4/0/2 | pack:intel | Specialist; reachable when a skill declares the pack. |
| `payload_lookup` | network roles; read-only class | undefined/undefined/0/0/1 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `pty_session` | flag ptySession | undefined/undefined/0/0/0 | merge-into:bash | Same as bash (session handle can return as a pack if an eval needs it). |
| `wp_fingerprint` | flag wpFingerprint; passive recon | undefined/undefined/1/0/1 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `discover_api_surface` | audit set; passive recon | undefined/undefined/0/0/0 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `surface_sweep` | audit set; passive recon | undefined/undefined/0/0/0 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `js_recon` | audit set; passive recon | undefined/undefined/0/0/0 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `mongo_objectid` | flag mongoObjectIdForge | undefined/undefined/0/0/1 | pack:web-probe | Specialist; reachable when a skill declares the pack. |
| `list_skills` | all roles | undefined/undefined/0/1/1 | merge-into:load_skill | Folded into load_skill. |
| `load_skill` | all roles; skill allow-list; read-only class | undefined/undefined/0/2/1 | core | Skills carry know-how and load packs. With no id it lists skills (absorbs list_skills). |
| `read_skill` | skill roles | undefined/undefined/0/0/1 | pack:skill-authoring | Specialist; reachable when a skill declares the pack. |
| `create_skill` | skill roles | undefined/undefined/0/0/1 | pack:skill-authoring | Specialist; reachable when a skill declares the pack. |
| `save_skill` | skill roles | undefined/undefined/0/0/1 | pack:skill-authoring | Specialist; reachable when a skill declares the pack. |
| `copy_skill` | skill roles | undefined/undefined/0/0/1 | pack:skill-authoring | Specialist; reachable when a skill declares the pack. |
| `done` | all roles | undefined/undefined/2/4/11 | core | Ends the run. |
| `run_scanner` | allowScanners only | undefined/undefined/0/0/0 | pack:scanners | Specialist; reachable when a skill declares the pack. |
| `structural_sqli_probe` | offensive-scoped set; needs scope | undefined/undefined/0/0/0 | pack:probes | Specialist; reachable when a skill declares the pack. |
| `prompt_layer_probe` | offensive-scoped set; needs scope | undefined/undefined/0/0/0 | pack:probes | Specialist; reachable when a skill declares the pack. |
| `auth_boundary_probe` | offensive-scoped set; needs scope | undefined/undefined/0/0/0 | pack:access-control | Specialist; reachable when a skill declares the pack. |
| `cloud_s3_probe` | flag cloudSurface | undefined/undefined/0/0/0 | pack:cloud | Specialist; reachable when a skill declares the pack. |
| `cloud_validate_credentials` | flag cloudSurface | undefined/undefined/0/0/0 | pack:cloud | Specialist; reachable when a skill declares the pack. |
| `oast_register` | flag oastCollaborator | undefined/undefined/0/0/0 | pack:oast | Specialist; reachable when a skill declares the pack. |
| `oast_poll` | flag oastCollaborator | undefined/undefined/0/0/0 | pack:oast | Specialist; reachable when a skill declares the pack. |
| `python_exec` | flag pythonExec | undefined/undefined/0/0/1 | merge-into:bash | Same as bash plus python3. |
| `js_eval` | network roles; wraps guarded shell | undefined/undefined/0/0/0 | merge-into:bash | Same as bash plus node -e. |
| `python_eval` | network roles; wraps guarded shell | undefined/undefined/0/0/0 | merge-into:bash | Same as bash plus python3 -c. |
| `analyze_binary` | flag zeroverse; path-confined | undefined/undefined/0/0/0 | pack:binary | Specialist; reachable when a skill declares the pack. |
| `ask_operator` | audit/review set; read-only class | undefined/undefined/0/0/0 | core | Human-in-the-loop channel; no shell equivalent. |
| `update_todos` | common set; read-only class | undefined/undefined/0/0/0 | pack:planning | Specialist; reachable when a skill declares the pack. |
| `write_todos` | alias, never advertised | undefined/undefined/0/0/0 | merge-into:update_todos | Duplicate of update_todos. |
| `visualize` | common set; read-only class | undefined/undefined/1/0/1 | pack:planning | Specialist; reachable when a skill declares the pack. |
| `self_extend` | operator opt-in allowModelSelfExtension (default off) | undefined/undefined/0/0/2 | special | Operator-enabled extension point, not part of the default list. |
| `remember_codebase` | only when codebase learning is on | undefined/undefined/0/1/1 | special | Injected by the learning feature, not by role. |
| `proxy` | never advertised by role today; registered and tested only | undefined/undefined/3/1/11 | pack:proxy | Specialist; reachable when a skill declares the pack. |
| `ad_attack_paths` | trusted audit/review only (not hostile scope) | undefined/undefined/1/0/0 | pack:identity | Specialist; reachable when a skill declares the pack. |
| `entra_attack_paths` | trusted audit/review only | undefined/undefined/2/0/0 | pack:identity | Specialist; reachable when a skill declares the pack. |
| `entra_posture` | trusted audit/review only; network | undefined/undefined/2/0/0 | pack:identity | Specialist; reachable when a skill declares the pack. |
| `assemble_advisory` | trusted audit/review only | undefined/undefined/3/0/0 | pack:intel | Specialist; reachable when a skill declares the pack. |
| `cve_lookup` | trusted audit/review only; network | undefined/undefined/2/0/0 | pack:intel | Specialist; reachable when a skill declares the pack. |
| `variant_hunt` | trusted audit/review only | undefined/undefined/4/0/0 | pack:source-audit | Specialist; reachable when a skill declares the pack. |
| `assumption_hunt` | trusted audit/review only | undefined/undefined/2/0/0 | pack:source-audit | Specialist; reachable when a skill declares the pack. |
| `generate_fix` | trusted audit/review only | undefined/undefined/2/0/1 | pack:source-audit | Specialist; reachable when a skill declares the pack. |
| `verify_finding` | needs scope; sends traffic | undefined/undefined/3/0/1 | pack:source-audit | Specialist; reachable when a skill declares the pack. |
| `protocol_conformance` | offensive-scoped set | undefined/undefined/1/0/0 | pack:source-audit | Specialist; reachable when a skill declares the pack. |
| `spec_drift` | offensive-scoped set | undefined/undefined/1/0/0 | pack:source-audit | Specialist; reachable when a skill declares the pack. |
| `safety_eval` | offensive-scoped set | undefined/undefined/1/0/0 | pack:source-audit | Specialist; reachable when a skill declares the pack. |
| `memsafety_fuzz` | flag memsafetyFuzz + scope | undefined/undefined/0/0/0 | pack:fuzz | Specialist; reachable when a skill declares the pack. |
| `npm_dynamic_discovery` | flag npmDynamicDiscovery + scope | undefined/undefined/1/0/0 | pack:fuzz | Specialist; reachable when a skill declares the pack. |
| `weaponize_kernel` | flag kernelWeaponize + scope | undefined/undefined/1/0/0 | pack:kernel | Specialist; reachable when a skill declares the pack. |
| `cve_adapt` | flag cveAdapt + scope | undefined/undefined/1/0/0 | pack:kernel | Specialist; reachable when a skill declares the pack. |


Totals: 11 core, 55 in packs, 8 aliases (merged duplicates), 2 special (operator-enabled or
feature-injected) = 76. **No tool was deleted.** Every old name must keep dispatching for stored
sessions, saved workflows and skills; the aliases are hidden from the advertised list, not removed.
Deleting them is a later step after a saved-conversation window (see skills-as-the-unit.md 8.3).

## 3. Safety with the shell as the main action tool

Where each boundary is enforced (read from code, then tested through the real console
dispatch in `packages/engine/src/console/core-toolset-safety.test.ts`):

| Boundary | Enforced in | Does it depend on parsing shell text? |
|---|---|---|
| Budget and sandbox | Cost ceiling and time caps stop a run; the optional container executor (SmolVM or Docker) isolates commands from the host | No |
| Ask before running commands | `executionPolicy` plus the per-action approval gate: every effectful call, `bash` included, is put to the operator and does not run unless approved | No |
| Target scope (hosts) | Network-capable tools go through the scope gate; `shellExec` additionally extracts URLs from the command and refuses any out-of-scope host or path before running (`agent/tools.ts`, `shellExec`) | Yes, for the URL check |
| Scanner-binary suppression, rate limits, http_audit egress | `shellExec` pre-flight | Yes |

Tests (all pass): ask-first runs nothing the operator declines and runs it after approval; six out-of-scope host
spellings (`curl -X POST`, `--data`, `python3 -c urlopen`, `bash -c curl`, `wget`, `$()` in
the URL) are refused without growing the scope.

Decision on the classifier: I did not build a read-only shell, and since 2026-11-15 there is no
Read-only mode at all (one mode: shell access). A text allowlist cannot be made reliable
(`find -exec`, `awk system()`, `git -c`, `sed w`, `xargs`, `env` are all "read" commands that
write), so the limits are scope, budget, the sandbox and Ask before running commands.

### Gaps I could not close

1. **Hosts built at run time are invisible to the shell scope check.** `curl "$(printf
   'https://evil.%s/x' example)"`, `h=evil.example; curl https://$h/x`, base64-decoded URLs and
   `socket.create_connection(('evil.' + 'example', 443))` carry no URL in the text. This is the
   gap already documented in `shellExec` ("a cleverer agent ... is NOT caught"). It matters more
   with a shell-first default. The test `Known gap` pins it, so closing it forces an update.
   The real fix is at the executor: a network proxy or network-isolated sandbox (container or
   seatbelt profile with a host allowlist) so scope does not depend on text. Not implemented
   here; scope enforcement for the Thread shell today is text-level plus the host executor.
2. **The shell runs on the host** unless an execution profile selects a sandbox.
   File writes by `bash` are not confined to the granted folder by anything but the approval
   gate (`ask`) and the operator's trust; `apply_patch` and `str_replace` are confined, `bash`
   is not.
3. *(Closed 2026-11-15.)* Read-only Threads could not call `save_finding`. Read-only is removed,
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
