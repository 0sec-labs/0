# Command hook architecture (`beforeCommand`)

## Modules

```
hooks/before-command.ts      types + decision pipeline (core, no imports)
hooks/approvals-policy.ts    Ask-before-running as the weakest decider
hooks/protected-paths*.ts    protected-paths decider: agents may not touch approval, enablement, settings, db files
hooks/real-path.ts           symlink-resolving path helper shared by deciders
agent/before-command.ts      composition root: ordered built-ins, runBeforeCommand()
agent/command-hook.ts        which tools execute, and how a tool call becomes a hook input (pure)
console/turn-engine/before-command.ts   tool call -> hook input (pure)
```

```
console session ----+
                    +--> runBeforeCommand --> [protected-paths] [approvals] --> allow|ask|deny
ToolExecutor.execute +         (hooks)                 |        |
  (every executing tool)                               |        +- reads thread.approvals only
                                                       +- text analysis of the command, paths symlink-resolved
```

Dependencies: `agent` -> `hooks`; `hooks` -> nothing. `hooks/before-command.ts` has no runtime imports.

## Decision rules

- Input: `{kind, command, argv, cwd, hosts, paths, thread, effectful}`. `kind` is `bash | process | network | file-write | file-read`. Output per decider:
  `allow | deny(reason) | ask(reason)`. Combination: any deny wins, then any ask.
- A decider that throws, rejects, times out (5 s) or answers nonsense is a deny.
- Order is documentation, not priority: the combination rule is order independent.
  Approvals is last because it is the weakest policy: it can only ask.
- Only first-party built-ins are deciders. There is no registration API for plugins.
- The session turns an ask into an approve-tool prompt. The
  executor, which has no operator channel, acts only on deny.

## One entry for every executing tool

`ToolExecutor.execute()` runs `runBeforeCommand` before dispatching any tool listed as executing in
`agent/command-hook.ts`: bash (kind `bash`) and str_replace (`file-write`). Subagents use their own
executor, so their calls reach the hook too. Repository acquisition is a bash command and now runs after the hook,
not before it. The console session projects the same kinds, command text, cwd and paths.

Every tool in the registry is classified exactly once as executing, network, delegating or inert.
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

## Invariants

1. Deny on error: no failure inside a decider can turn into an allow.

## Known gaps

- The sandbox choice selects an executor; it is not a per-command decision and does not use the hook.
- Writes outside the workspace are classified `file-write` but only approvals decides them.
- Network tools (web_search, and any extension or MCP tool) are only put through the hook by the console, as kind `network`.
- The protected-paths analysis is textual (see above) and not a boundary.
