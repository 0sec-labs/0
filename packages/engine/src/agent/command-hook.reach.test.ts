import { describe, expect, it, vi } from "vitest";

const seen: Array<{ kind: string; command: string }> = [];
vi.mock("./before-command.js", () => ({
  runBeforeCommand: async (input: { kind: string; command: string }) => { seen.push({ kind: input.kind, command: input.command }); return { decision: "deny", reason: "hook-reached", denies: [], asks: [] }; },
}));

import { EXECUTING_TOOLS } from "./command-hook.js";
import { ToolExecutor } from "./tools.js";
import type { ToolContext } from "./types.js";

const ARGS: Record<string, Record<string, unknown>> = {
  bash: { command: "echo a" }, js_eval: { code: "1" }, python_eval: { code: "1" }, python_exec: { code: "1" },
  run_command: { command: "ls" }, monitor: { op: "start", name: "m", command: "sleep", args: ["1"] }, pty_session: { action: "send", session_name: "s", input: "id" },
  run_scanner: { tool: "nmap", target: "https://target.test" }, analyze_binary: { binary_path: "/bin/ls" },
  memsafety_fuzz: {}, npm_dynamic_discovery: {}, weaponize_kernel: {}, cve_adapt: {}, self_extend: {},
  str_replace: { path: "a.txt", old_string: "a", new_string: "b" }, apply_patch: { patch: "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch" },
  create_skill: {}, save_skill: {}, copy_skill: {}, read_file: { path: "a.txt" }, list_files: { path: "." }, search_files: { path: ".", pattern: "a" },
};

describe("every executing tool reaches beforeCommand through ToolExecutor.execute", () => {
  const ctx = { target: "https://target.test", scanId: "reach", findings: [], attackResults: [], targetInfo: {} } as unknown as ToolContext;
  for (const name of Object.keys(EXECUTING_TOOLS)) {
    it(name, async () => {
      seen.length = 0;
      const result = await new ToolExecutor(ctx, null).execute({ name, arguments: ARGS[name] ?? {} });
      expect(seen.length, `${name} never called beforeCommand`).toBeGreaterThan(0);
      expect(result.success).toBe(false);
      expect(result.error).toContain("hook-reached");
    });
  }
});
