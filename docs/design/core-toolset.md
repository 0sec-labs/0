# Core toolset

Principles: [tool-philosophy.md](tool-philosophy.md).

## Result

Eight tools: `bash`, `str_replace`, `finding`, `ask_operator`, `load_skill`, `web_search`,
`spawn_agent` and `memory` (when Memory is on). Files are read through the shell. `str_replace`
creates a file when `old_string` is empty. A reply with no tool call ends the turn.

Code: `packages/engine/src/agent/toolset.ts`, wiring in `console/turn-engine/session.ts`.

## Safety with the shell as the main action tool

Where each boundary is enforced (tested through the real console dispatch in
`packages/engine/src/console/core-toolset-safety.test.ts`):

| Boundary | Enforced in | Does it depend on parsing shell text? |
|---|---|---|
| Sandbox | The optional container executor (SmolVM or Docker) isolates commands from the host | No |
| Ask before running commands | `executionPolicy` plus the per-action approval gate: every effectful call, `bash` included, is put to the operator and does not run unless approved | No |

There is no read-only shell. A text allowlist cannot be made reliable (`find -exec`,
`awk system()`, `git -c`, `sed w`, `xargs`, `env` are all "read" commands that write), so the
limits are the sandbox and Ask before running commands.

The shell runs on the host unless an execution profile selects a sandbox. File writes by `bash`
are not confined to the granted folder by anything but the approval gate and the operator's trust;
`str_replace` is confined.
