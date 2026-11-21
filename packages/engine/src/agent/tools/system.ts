/**
 * System / execution tool definitions (0#611 — split out of the monolithic
 * agent/tools.ts registry).
 *
 * Local execution, filesystem reads, interactive sessions, sub-agent
 * spawning and target-profile updates.
 *
 * Pure `ToolDefinition` metadata (name / description / parameter schema). The
 * ./tools/index.ts barrel merges every per-domain map into the canonical
 * `TOOL_DEFINITIONS` registry; the matching runtime handlers live on the
 * `ToolExecutor` class in agent/tools.ts.
 */
import type { ToolDefinition, ToolParam } from "../types.js";

const expectedWorkspaceParameter: ToolParam = {
  type: "object",
  description: "Machine-checked source identity. Supply for an explicit absolute source path or pinned commit; task prose is not a path/revision contract. Path must match the parent's configured source checkout (select another workspace first); this never grants access or falls back to the default workspace.",
  properties: {
    path: { type: "string", description: "Absolute path to the intended source checkout." },
    head: { type: "string", description: "Full 40- or 64-character Git commit hash expected at HEAD." },
    origin: { type: "string", description: "Optional exact origin URL expected for this checkout." },
  },
  required: ["path", "head"],
  additionalProperties: false,
};

const allowedToolsParameter: ToolParam = {
  type: "array",
  description: "Optional machine-enforced tool allowlist for this worker and its descendants. Names must be available under the parent's capabilities and scope. Omit to inherit; [] permits no tools, including done or messaging. Restrictions persist across follow-ups and cannot be widened.",
  items: { type: "string" },
};

export const systemToolDefinitions: Record<string, ToolDefinition> = {
  str_replace: {
    name: "str_replace",
    description:
      "Edit a file: replace one exact string with another. " +
      "`old_string` must match the file contents EXACTLY — including all whitespace and indentation — and must be UNIQUE (appear once), " +
      "so include a few surrounding lines when a bare snippet would be ambiguous. Set `replace_all: true` to replace every occurrence instead. " +
      "To CREATE a new file, pass an empty `old_string` and the whole file text as `new_string` (parent folders are created; it refuses to overwrite a non-empty file). " +
      "Errors are explicit and self-correctable (not found / N matches not unique). Use bash for deletes, renames and multi-file patches (`git apply`). Path must be within the folder.",
    parameters: {
      path: { type: "string", description: "File path (relative to the folder or absolute) of the file to edit or create" },
      old_string: { type: "string", description: "Exact text to find, matching the file byte-for-byte including whitespace/indentation. Must be unique unless replace_all is set. Empty creates a new file." },
      new_string: { type: "string", description: "Text to replace it with (or the full content of the new file). May be empty to delete the matched text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)." },
    },
    required: ["path", "old_string", "new_string"],
  },


  spawn_agent: {
    name: "spawn_agent",
    description:
      "Start helper agents for independent sub-tasks, or manage them with op list, get, stop or stop_all. " +
      "For a spawn give one task, or tasks for several at once. Each helper has the same tools as you, including a shell, and works in the same folder: give each its own files so edits do not collide. " +
      "Helpers run in the background and report back to you; set wait:true to block until they finish. " +
      "To message a running helper, pass its agent_id with a new task (no other options).",
    parameters: {
      op: { type: "string", enum: ["spawn", "list", "get", "stop", "stop_all"], description: "Defaults to spawn. Management operations accept only op and, for get/stop, agent_id; they do not spawn workers or consume worker admission slots." },
      agent_id: { type: "string", description: "Owned worker ID for get/stop; existing directly owned background worker ID for follow-ups. With task, sends an immediate follow-up to that same worker; no batch, context or worker configuration overrides, and no wait:true." },
      allowed_tools: allowedToolsParameter,
      task: { type: "string", description: "One self-contained task: target files or URL, objective, constraints and required evidence. Cannot be combined with tasks." },
      tasks: {
        type: "array",
        description: "Independent tasks to schedule concurrently in a bounded pool. Cannot be combined with task. Default maximum 1024 tasks, configurable with ZERO_SUBAGENT_MAX_FANOUT; worker/depth and shared usage limits still apply.",
        items: {
          type: "object",
          properties: {
            allowed_tools: allowedToolsParameter,
            task: { type: "string", description: "Self-contained objective, exact scope, constraints and acceptance evidence." },
            name: { type: "string", description: "Optional display name for this worker." },
            expected_workspace: expectedWorkspaceParameter,
            role: { type: "string", description: "Optional operator-configured worker model role; does not grant permissions." },
            model: { type: "string", description: "Optional model ID, subject to the parent's approved model-selection policy and available credentials." },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
      context: { type: "string", description: "Optional shared background and constraints for the task or batch; avoid repeating it in every task." },
      name: { type: "string", description: "Optional display name for a single worker; use each batch item's name for tasks." },
      expected_workspace: expectedWorkspaceParameter,
      role: { type: "string", description: "Optional operator-configured model role for a single worker; does not grant permissions." },
      model: { type: "string", description: "Optional model ID for a single worker. Under an operator-configured auto-routing role it may name a reachable model; otherwise it must be one of the parent's operator-approved pins." },
      wait: { type: "boolean", description: "true waits for results. Omitted defaults to background in console sessions with result delivery, and blocking elsewhere. false requires a background result-delivery route." },
    },
  },

  bash: {
    name: "bash",
    description:
      "Run a shell command. Use curl, python3, jq, or any installed tool. Supports pipes, redirects, and multi-line scripts. Read files with `cat -n`, and read big files in ranges (`sed -n '100,220p' file`, `head -n 80 file`, `rg -n pattern file`); long output is cut to its start and end. The 0 CLI manages threads, agents, skills, memory and findings; run `0 --help` and `0 <name> --help`. A call ends when the command exits or the timeout is reached (default 30 s, max 120 s). " +
      "For a dev server, listener or long scan that must outlive the call: start it in the background with output redirected, `nohup <cmd> > /tmp/x.log 2>&1 & echo $!` (note the pid); " +
      "wait for readiness with a short loop, `for i in $(seq 60); do curl -sf localhost:3000 >/dev/null && break; sleep 1; done` or `grep -q ready /tmp/x.log`; " +
      "read output with `tail -n 50 /tmp/x.log`; stop it with `kill <pid>`. Always redirect output, or the call waits for the process to finish.",
    parameters: {
      command: { type: "string", description: "Shell command to execute. Supports pipes, redirects, and multi-line scripts." },
      timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)" },
    },
    required: ["command"],
  },
};

// Tool-name → ToolExecutor handler-method name (0#614). Co-located with
// this domain's definitions so a new tool adds its route here, not in a
// shared dispatch switch. Assembled by ./dispatch.ts; resolved off the
// executor instance in agent/tools.ts (handler bodies stay private methods).
export const systemDispatch: Record<string, string> = {
  str_replace: "strReplace",
  bash: "shellExec",
  spawn_agent: "spawnAgent",
};
