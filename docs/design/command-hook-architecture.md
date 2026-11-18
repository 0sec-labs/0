# Command hook architecture (`beforeCommand`)

Status: implemented (step 1 of `one-extension-system.md`).

## Modules

```
hooks/before-command.ts      types + decision pipeline (core, no imports)
hooks/approvals-policy.ts    Ask-before-running as the weakest decider
hooks/protected-paths*.ts    protected-paths decider: agents may not touch approval, enablement, settings, db files
hooks/real-path.ts           symlink-resolving path helper shared by deciders
agent/before-command.ts      composition root: ordered built-ins, runBeforeCommand()
agent/command-hook.ts        which tools execute, and how a tool call becomes a hook input (pure)
scope/before-command.ts      scope decider (built-in extension "scope")
scope/activation.ts          pinned run state, one accessor, AsyncLocalStorage
plugins/builtin-state.ts     getBuiltinPluginState(id): enabled / explicit / corrupt
plugins/builtin-store.ts     the ONE store for built-in enablement (extensions/state.json) + one-time migration
plugins/enablement.ts        per-project approvals of installed plugins; built-ins are read through builtin-store
console/turn-engine/before-command.ts   tool call -> hook input (pure)
```

```
console session ----+
                    +--> runBeforeCommand --> [protected-paths] [scope] [approvals] --> allow|ask|deny
ToolExecutor.execute +         (hooks)                 |            |        |
  (every executing tool)                               |            |        +- reads thread.approvals only
                                                       |            +- scope/activation -> plugins/builtin-state -> builtin-store
                                                       +- text analysis of the command, paths symlink-resolved
```

Dependencies: `agent` -> `hooks`, `scope`; `scope` -> `hooks` (types), `plugins`; `hooks` -> nothing. `scope` imports nothing from
cli or web. `hooks/before-command.ts` has no runtime imports.

## Decision rules

- Input: `{kind, command, argv, cwd, hosts, paths, thread, effectful}`. `kind` is `bash | process | network | file-write | file-read`. Output per decider:
  `allow | deny(reason) | ask(reason)`. Combination: any deny wins, then any ask.
- A decider that throws, rejects, times out (5 s) or answers nonsense is a deny.
- Order is documentation, not priority: the combination rule is order independent.
  Approvals is last because it is the weakest policy: it can only ask.
- Only first-party built-ins are deciders. There is no registration API for plugins.
- The session turns an ask into the right prompt (scope grant or approve tool). The
  executor, which has no operator channel, acts only on deny.

## One entry for every executing tool

`ToolExecutor.execute()` runs `runBeforeCommand` before dispatching any tool listed as executing in
`agent/command-hook.ts`: bash (kind `bash`) and str_replace (`file-write`). Subagents use their own
executor, so their calls reach the hook too. Repository acquisition is a bash command and now runs after the hook,
not before it. The console session projects the same kinds, command text, cwd and paths, and passes the thread's
http_audit path prefixes (it never did before).

Every tool in the registry is classified exactly once as executing, network (own scope gate), delegating or inert.
`agent/command-hook.test.ts` enumerates the registry and fails for an unclassified tool; `command-hook.reach.test.ts`
runs every executing tool through `ToolExecutor.execute` with a hook that denies and asserts each one reaches it.
A new tool therefore cannot silently bypass the hook.

## Protected paths (agents cannot approve themselves)

The `protected-paths` decider denies agent commands and file tools that touch `~/.0/extensions`, `plugins`,
`plugin-enablement`, `executable-plugins`, `harness-trust`, `evolution-authority`, the settings, backends and
credentials files and `0.db*`, and the approval-bearing CLI (`0 skills add|extensions enable|update|import|remove`,
`0 plugin enable|disable`, `0 skills ... --yes`). The reason tells the agent to ask the operator.
Reads are denied too: the approval state and the seal key are not for agents.

Covered by text analysis: absolute paths, `~`, `$HOME`, `${HOME}`, `cd`/`pushd` followed by relative paths, `..`,
redirects, tee, cp/mv/ln, `sed -i`, paths inside python/node one-liners, glob segments (`ext*`), and symlinks that exist
when the check runs (every path is resolved through `realpath` of its deepest existing ancestor).
Not covered: paths built at run time (string concatenation, `eval`, base64, a variable assembled over several
commands), a symlink created and followed inside one command, anything a script reads from a file it wrote. The
agent runs as the same OS user with bash. **This is a layer, not a boundary.** The sandbox is the hard boundary.

## Scope extension

- No scope defined: allow. A scope defined (flag, project, Agent, automation, PR checkout):
  enforce. Scope defined and extension disabled or failing: deny.
- Enablement has ONE store: `extensions/state.json` `builtins` (global, not per project). Absent = default on;
  `explicit` = an operator turned it on (enforces even with no scope, as before); `enabled: false` = disabled.
  Both `0 skills extensions enable|disable scope` and the older `0 plugin enable|disable scope` write it.
- The old per-project schema-2 records are a migration source, read once (explicit enable wins over a schema-2 record
  without `scope`, which migrates as a disable), then ignored. A missing or unparseable record means default on. A
  parseable schema-2 record of this project with a broken `enabled` field, before migration, is `corrupt`: with a scope
  defined, commands are denied with a message naming the file and the fix; with none defined, nothing is restricted.
- The project that keys scope state is the thread's cwd or workspace root, passed explicitly; `process.cwd()` is
  only the last resort.
- With an explicit local source folder (`withLocalSourceBoundary`), `input.paths` and `input.cwd` outside it are
  denied whether or not a host scope exists. Hosts are read from the command text of every kind.

## Invariants

1. Scope never grows during a run. The state is pinned with `withScopeEnforcement`;
   `getScopeEnforcementState(.., scopeDefined)` can only add enforcement, never remove it,
   and re-reading the stored record mid-run does not weaken a pinned run.
2. Deny on error: no failure inside a decider can turn into an allow.
3. A `ScopePolicy` or `PathPolicy` object is itself a defined scope: `enforce()` always
   decides and fails closed when the extension is disabled.

## Known gaps

- The check is textual. A host built from a variable, base64 or a temp file inside a bash
  command is not visible (tested as "Known gap").
- Per-tool scope checks remain where they guard a different layer (SSRF rail, redirect
  re-validation, DNS answer checks in `http.ts`, local path checks, interactive scope grants in
  `console/turn-engine/session.ts`). They are defence in depth behind the hook, not a second policy.
- The sandbox choice selects an executor; it is not a per-command decision and does not use the hook.
- Writes outside the workspace are classified `file-write` but only approvals decides them.
- Network tools (web_search, and any extension or MCP tool) keep their own scope gates in the engine path; only the console also
  puts them through the hook as kind `network`.
- The protected-paths analysis is textual (see above) and not a boundary.
