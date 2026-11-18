import { describe, expect, it } from "vitest";
import { beforeCommandInputForCall, type CallHookContext } from "./before-command.js";

const ctx = (over: Partial<CallHookContext> = {}): CallHookContext => ({ threadId: "t", target: "https://t.test", cwd: "/w", scope: undefined, approvals: "ask", networkCapable: true, readOnly: false, canAskScope: false, ...over });

describe("console tool call -> beforeCommand input", () => {
  it("gives each executing tool its own kind, command text, cwd and paths", () => {
    expect(beforeCommandInputForCall({ id: "1", name: "bash", arguments: { command: "curl https://x.test" } }, ctx())).toMatchObject({ kind: "bash", command: "curl https://x.test" });
    expect(beforeCommandInputForCall({ id: "1", name: "str_replace", arguments: { path: "a.txt" } }, ctx({ networkCapable: false }))).toMatchObject({ kind: "file-write", paths: ["a.txt"] });
  });
  it("carries the thread's http_audit path prefixes", () => {
    expect(beforeCommandInputForCall({ id: "1", name: "bash", arguments: { command: "x" } }, ctx({ pathPrefixes: ["/api"] })).thread.pathPrefixes).toEqual(["/api"]);
    expect(beforeCommandInputForCall({ id: "1", name: "bash", arguments: { command: "x" } }, ctx()).thread.pathPrefixes).toBeUndefined();
  });
});
