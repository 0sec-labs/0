import { describe, expect, it } from "vitest";
import { DELEGATING_TOOLS, EXECUTING_TOOLS, INERT_TOOLS, NETWORK_TOOLS, classifyTool, hookInputForTool } from "./command-hook.js";
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
    for (const name of ["bash", "str_replace"]) {
      expect(hookInputForTool(name, { command: "x", op: "start", code: "x", action: "send", input: "x", tool: "nmap", path: "p", patch: "*** Update File: a" }, { cwd: "/w", thread: {} }), name).not.toBeNull();
    }
    expect(hookInputForTool("finding", {}, { cwd: "/w", thread: {} })).toBeNull();
  });
  it("maps each executing tool to a kind and exposes its command text, cwd and paths", () => {
    const base = { cwd: "/w", thread: {} };
    expect(hookInputForTool("bash", { command: "curl https://x.test" }, base)).toMatchObject({ kind: "bash", command: "curl https://x.test" });
    expect(hookInputForTool("str_replace", { path: "a/b" }, base)).toMatchObject({ kind: "file-write", paths: ["a/b"] });
  });
});
