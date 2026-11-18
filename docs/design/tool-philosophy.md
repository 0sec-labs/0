# Tool philosophy

The evidence and the per-tool table are in [core-toolset.md](core-toolset.md).

## Principles

1. **Small core.** The model sees eight tools: `bash`, `str_replace`, `finding`,
   `ask_operator`, `load_skill`, `web_search`, `spawn_agent` and `memory`. Every extra schema costs tokens on every turn and makes
   the model pick worse.
2. **Shell first.** The model already knows `curl`, `jq`, `git`, `python3`. A
   capability that a shell command can express is not a tool.
3. **Everything else is a skill.** Know-how lives in skills (instructions and
   scripts), loaded on demand with `load_skill`; nothing about it sits in the default prompt.
4. **Verify before claiming.** "Verified" is set by harness
   code (the verifier gate), never by a tool the model can call.
5. **Fewer tools never means weaker guards.** "Ask before running commands" is enforced at dispatch and in the executor,
   not in the prompt and not by parsing shell text. There is one mode (shell
   access); there is no read-only variant.
6. **Keep schemas stable.** The advertised list and its order do not change
   during a task. Stable prefixes keep the prompt cache warm.
