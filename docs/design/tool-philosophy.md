# Tool philosophy

Status: decided by the owner ("narrow it down a lot; bash only; follow Pi; clean
up"). The evidence and the per-tool table are in
[core-toolset.md](core-toolset.md). How skills fit is in
[skills-as-the-unit.md](skills-as-the-unit.md).

## Principles

1. **Small core.** The model sees eight tools by default: `bash`, `str_replace`, `finding`,
   `ask_operator`, `load_skill`, `web_search`, `spawn_agent` and `memory`. Every extra schema costs tokens on every turn and makes
   the model pick worse.
2. **Shell first.** The model already knows `curl`, `jq`, `git`, `python3`. A
   capability that a shell command can express is not a tool.
3. **Everything else is a skill.** Know-how lives in skills (instructions,
   scripts, and optionally a tool pack). A skill is loaded on demand with
   `load_skill`; nothing about it sits in the default prompt.
4. **No tool unless a skill needs it.** A tool exists because a skill declares a
   pack that includes it, because the harness needs it internally, or because the
   operator enabled it. A tool nobody references is deleted, not hidden.
5. **Verify before claiming.** `done` is a claim. "Verified" is set by harness
   code (the verifier gate), never by a tool the model can call.
6. **Fewer tools never means weaker guards.** Budget and
   "ask before running commands" are enforced at dispatch and in the executor,
   not in the prompt and not by parsing shell text. There is one mode (shell
   access); there is no read-only variant. The shell's scope check reads URLs from the command text, so
   isolation for hosts built at run time belongs in the sandbox; see the known
   gaps in the core-toolset doc.
7. **Keep schemas stable.** The advertised list and its order do not change
   during a task, except at a turn boundary when a loaded skill adds its pack.
   Stable prefixes keep the prompt cache warm.
8. **Measure, do not assume.** A tool list change is a behavior change. Compare
   `core` and `full` on the same tasks and model before changing a default.

## How to add a pack

1. Register the tool definition and handler as today (the per-domain file under
   `packages/engine/src/agent/tools/` and `dispatch.ts`). Gating (role,
   feature flag) stays where it is; a pack never grants authority.
2. Add the tool name to one pack in `TOOL_PACKS`
   (`packages/engine/src/agent/toolset.ts`), or create a new pack. A name may live
   in exactly one place; the registry test enforces it.
3. In the built-in skill that needs it, add `tools: [pack-name]` to the YAML
   (`core` and `pack:<name>` spellings are accepted). Only built-in skills can
   declare packs; folder skills from a repository cannot.
4. Run `node packages/engine/scripts/generate-skills-manifest.mjs` and the tests
   `src/console/core-toolset.test.ts` and `src/agent/skills`.
5. Do not rename an old tool name that stored sessions still use. Add it to `TOOL_ALIASES` so stored
   sessions and workflows keep dispatching.

## Switching the list

`toolset: "core" | "full"` per run. Resolution: explicit value, then
`ZERO_TOOLSET`, then the surface default (`core` for the console, `full` for scans
until the A/B passes). The hidden CLI flag `--toolset core|full` sets the
environment variable for A/B runs.
