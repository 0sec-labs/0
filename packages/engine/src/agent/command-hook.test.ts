import { describe, expect, it } from "vitest";
import { DELEGATING_TOOLS, EXECUTING_TOOLS, INERT_TOOLS, NETWORK_TOOLS, classifyTool, hookInputForTool, patchTargets } from "./command-hook.js";
import { TOOL_DEFINITIONS } from "./tools/index.js";
import { TOOL_DISPATCH } from "./tools/dispatch.js";

const registered = [...new Set([...Object.keys(TOOL_DEFINITIONS), ...Object.keys(TOOL_DISPATCH)])];

describe("every tool is classified for beforeCommand", () => {
  it("has a class for each registry and dispatch tool; a new tool must be added to exactly one set", () => {
    expect(registered.filter(name => classifyTool(name) === "unclassified")).toEqual([]);
  });
  it("classifies no tool twice and no stale names", () => {
    const sets = [Object.keys(EXECUTING_TOOLS), [...NETWORK_TOOLS], [...DELEGATING_TOOLS], [...INERT_TOOLS]];
    const all = sets.flat();
    expect(all.filter((n, i) => all.indexOf(n) !== i)).toEqual([]);
    expect(all.filter(n => !registered.includes(n))).toEqual([]);
  });
  it("hooks the tools that execute, and not a tool that only reads a lookup table", () => {
    for (const name of ["bash", "monitor", "pty_session", "python_exec", "python_eval", "js_eval", "run_command", "run_scanner", "str_replace", "apply_patch"]) {
      expect(hookInputForTool(name, { command: "x", op: "start", code: "x", action: "send", input: "x", tool: "nmap", path: "p", patch: "*** Update File: a" }, { cwd: "/w", thread: {} }), name).not.toBeNull();
    }
    expect(hookInputForTool("save_finding", {}, { cwd: "/w", thread: {} })).toBeNull();
  });
  it("maps each executing tool to a kind and exposes its command text, cwd and paths", () => {
    const base = { cwd: "/w", thread: {} };
    expect(hookInputForTool("monitor", { op: "start", command: "node", args: ["a.js", "https://x.test"], cwd: "sub" }, base)).toMatchObject({ kind: "process", command: "node a.js https://x.test", cwd: "/w/sub" });
    expect(hookInputForTool("pty_session", { action: "send", input: "curl https://x.test" }, base)).toMatchObject({ kind: "process", command: "curl https://x.test" });
    expect(hookInputForTool("python_exec", { code: "import os" }, base)).toMatchObject({ kind: "bash", command: "import os" });
    expect(hookInputForTool("str_replace", { path: "a/b" }, base)).toMatchObject({ kind: "file-write", paths: ["a/b"] });
    expect(hookInputForTool("read_file", { path: "a" }, base)).toMatchObject({ kind: "file-read", effectful: false });
  });
  it("reads every target out of an apply_patch envelope", () => {
    expect(patchTargets("*** Begin Patch\n*** Add File: a/b.txt\n+x\n*** Update File: c.txt\n*** Delete File: d\n*** End Patch")).toEqual(["a/b.txt", "c.txt", "d"]);
  });
});
