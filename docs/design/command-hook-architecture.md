# Command hook architecture (`beforeCommand`)

Status: implemented (step 1 of `one-extension-system.md`).

## Modules

```
hooks/before-command.ts      types + decision pipeline (core, no imports)
hooks/approvals-policy.ts    Ask-before-running as the weakest decider
agent/before-command.ts      composition root: ordered built-ins, runBeforeCommand()
scope/before-command.ts      scope decider (built-in extension "scope")
scope/activation.ts          pinned run state, one accessor, AsyncLocalStorage
plugins/builtin-state.ts     getBuiltinPluginState(id): enabled / explicit
plugins/enablement.ts        stored record, schema 2, default-on migration
console/turn-engine/before-command.ts   tool call -> hook input (pure)
```

```
session dispatch --+
                   +--> runBeforeCommand --> [scope] [approvals] --> allow|ask|deny
tool executor bash-+          (hooks)            |        |
                                                 |        +- reads thread.approvals only
                                                 +- scope/activation -> plugins/builtin-state -> enablement
```

Dependencies: `agent` -> `hooks`, `scope`; `scope` -> `hooks` (types), `plugins`; `hooks` -> nothing. `scope` imports nothing from
cli or web. `hooks/before-command.ts` has no runtime imports.

## Decision rules

- Input: `{kind, command, argv, cwd, hosts, paths, thread, effectful}`. Output per decider:
  `allow | deny(reason) | ask(reason)`. Combination: any deny wins, then any ask.
- A decider that throws, rejects, times out (5 s) or answers nonsense is a deny.
- Order is documentation, not priority: the combination rule is order independent.
  Approvals is last because it is the weakest policy: it can only ask.
- Only first-party built-ins are deciders. There is no registration API for plugins.
- The session turns an ask into the right prompt (scope grant or approve tool). The
  executor, which has no operator channel, acts only on deny.

## Scope extension

- No scope defined: allow. A scope defined (flag, project, Agent, automation, PR checkout):
  enforce. Scope defined and extension disabled or failing: deny.
- Enablement record: schema 2. A missing, unreadable or schema 1 record means default on;
  an explicit schema 1 approval stays "explicit" (enforces even with no scope, as before);
  a schema 2 record without `scope` is an explicit disable.

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
