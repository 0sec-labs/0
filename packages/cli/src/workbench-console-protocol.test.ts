import { describe, expect, it } from "vitest";
import { WorkbenchFrameReader, encodeWorkbenchFrame, guestWorkspacePath, hostWorkspacePath, mapWorkbenchTarget, serializeWorkbenchConfig, mapWorkbenchCliArguments } from "./workbench-console-protocol.js";

describe("workbench controller boundary", () => {
  it("frames partial streams and rejects method-shaped or oversized messages", () => {
    const reader = new WorkbenchFrameReader(); const frames: unknown[] = [];
    reader.push('{"type":"state",', frame => frames.push(frame)); reader.push('"id":"safe-id"}\n', frame => frames.push(frame));
    expect(frames).toEqual([{ type: "state", id: "safe-id" }]);
    expect(() => reader.push('{"type":"request","id":"../../host"}\n', () => {})).toThrow("request id");
    expect(() => encodeWorkbenchFrame({ type: "state", data: "x".repeat(8 * 1024 * 1024) })).toThrow("byte limit");
  });
  it("maps only granted structured source paths and preserves prose", () => {
    expect(guestWorkspacePath("/operator/repo/a.txt", "/operator/repo")).toBe("/workspace/a.txt");
    expect(hostWorkspacePath("/workspace/a.txt", "/operator/repo")).toBe("/operator/repo/a.txt");
    expect(mapWorkbenchTarget("source:/operator/repo", "/operator/repo")).toBe("source:/workspace");
    expect(mapWorkbenchTarget("please inspect /operator/private", "/operator/repo")).toBe("please inspect /operator/private");
    expect(() => guestWorkspacePath("/operator/repo-other", "/operator/repo")).toThrow("outside");
    expect(() => guestWorkspacePath("/workspace/../etc", "/operator/repo")).toThrow("Invalid");
    expect(() => hostWorkspacePath("/workspace/../../etc", "/operator/repo")).toThrow("Invalid");
  });
  it("maps known CLI path flags while preserving operator prose", () => {
    expect(mapWorkbenchCliArguments(["scan", "--target=source:/operator/repo/src", "--scope", "/operator/repo/scope.json", "--print", "inspect /operator/private", "--model", "granted"], "/operator/repo")).toEqual(["scan", "--target=source:/workspace/src", "--scope", "/workspace/scope.json", "--print", "inspect /operator/private", "--model", "granted"]);
    expect(mapWorkbenchCliArguments(["workflow", "run", "--inputs", "/operator/repo/inputs.json"], "/operator/repo")).toEqual(["workflow", "run", "--inputs", "/workspace/inputs.json"]);
    expect(() => mapWorkbenchCliArguments(["workflow", "run", "--inputs", "/operator/private/inputs.json"], "/operator/repo")).toThrow("outside");
    expect(() => mapWorkbenchCliArguments(["scan", "--target", "/operator/other"], "/operator/repo")).toThrow("outside");
  });
  it("does not serialize host authentication or executable resources", () => {
    const config = { target: "/operator/repo", workspaceRoot: "/operator/repo", autonomyMode: "standard" as const, askOperator: async () => null };
    expect(serializeWorkbenchConfig(config, "/operator/repo")).toEqual({ target: "/workspace", workspaceRoot: "/workspace", autonomyMode: "standard" });
    expect(() => serializeWorkbenchConfig({ ...config, pluginHost: {} } as never, "/operator/repo")).toThrow("cannot execute");
  });
});
