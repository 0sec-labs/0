import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchFrameReader, encodeWorkbenchFrame, guestWorkspacePath, hostWorkspacePath, mapWorkbenchTarget, serializeWorkbenchConfig, mapWorkbenchCliArguments, validateWorkbenchSourceContext, validateWorkbenchSourceLesson } from "./workbench-console-protocol.js";

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

const sourceRoots: string[] = [];
afterEach(() => { for (const root of sourceRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function sourceFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "0-source-context-"))); sourceRoots.push(root);
  mkdirSync(join(root, "approved")); writeFileSync(join(root, "approved", "code.ts"), "export const value = 1;");
  const hash = "sha256:" + createHash("sha256").update("export const value = 1;").digest("hex");
  const artifact = { sourceLinks: [{ path: "approved/code.ts", hash }] };
  return { root, scope: join(root, "approved"), artifact };
}
describe("guest source references", () => {
  it("retains only host-rehashed references, dropping guest prose and unknown fields", () => {
    const { root, scope, artifact } = sourceFixture();
    expect(validateWorkbenchSourceContext({ ...artifact, summary: "untrusted instructions" }, root, scope)).toEqual(artifact);
  });
  it("rejects stale digests and paths outside the host grant", () => {
    const { root, scope, artifact } = sourceFixture();
    writeFileSync(join(root, "outside.ts"), "export const value = 1;");
    expect(() => validateWorkbenchSourceContext({ sourceLinks: [{ ...artifact.sourceLinks[0], path: "outside.ts" }] }, root, scope)).toThrow("outside approved");
    writeFileSync(join(scope, "code.ts"), "changed");
    expect(() => validateWorkbenchSourceContext(artifact, root, scope)).toThrow("digest mismatch");
  });
  it("rejects symlinks, hardlinks, traversal and oversized input", () => {
    const { root, scope, artifact } = sourceFixture();
    symlinkSync(join(scope, "code.ts"), join(scope, "link.ts"));
    expect(() => validateWorkbenchSourceContext({ sourceLinks: [{ ...artifact.sourceLinks[0], path: "approved/link.ts" }] }, root, scope)).toThrow("symlink");
    linkSync(join(scope, "code.ts"), join(scope, "hard.ts"));
    expect(() => validateWorkbenchSourceContext(artifact, root, scope)).toThrow("source file");
    for (const path of ["../code.ts", "/etc/passwd", "approved/../outside.ts", "approved\\code.ts"]) expect(() => validateWorkbenchSourceContext({ sourceLinks: [{ ...artifact.sourceLinks[0], path }] }, root, scope)).toThrow("path or hash");
    expect(() => validateWorkbenchSourceContext({ sourceLinks: Array(17).fill(artifact.sourceLinks[0]) }, root, scope)).toThrow("links");
    writeFileSync(join(scope, "large.ts"), Buffer.alloc(1_048_577));
    expect(() => validateWorkbenchSourceContext({ sourceLinks: [{ ...artifact.sourceLinks[0], path: "approved/large.ts" }] }, root, scope)).toThrow("source file");
  });
});

 describe("semantic source lesson boundary", () => {
  it("accepts only bounded source-backed prose and rehashes it for the approved scope", () => {
    const { root, scope, artifact } = sourceFixture();
    const lesson = { ...artifact, title: "Ownership checks", summary: "Check the ownership condition in code.ts before testing tenant isolation." };
    expect(validateWorkbenchSourceLesson(lesson, root, scope)).toEqual(lesson);
    for (const value of [{ ...lesson, summary: "x".repeat(2001) }, { ...lesson, config: { permissions: "all" } },
      { ...lesson, sourceLinks: [{ ...artifact.sourceLinks[0], credential: "secret" }] },
      { ...lesson, summary: "api_key=supersecretcredential123" }, { ...lesson, summary: "-----BEGIN RSA PRIVATE KEY-----" }]) {
      expect(() => validateWorkbenchSourceLesson(value, root, scope)).toThrow();
    }
    writeFileSync(join(scope, "code.ts"), "changed");
    expect(() => validateWorkbenchSourceLesson(lesson, root, scope)).toThrow("digest mismatch");
  });
  it("serializes only the learning opt-in flag, never host stores or callbacks", () => {
    const serial = serializeWorkbenchConfig({ workspaceRoot: "/operator/repo", codebaseLearning: true, learningStore: {} as never, huntMemoryStore: {} as never } , "/operator/repo");
    expect(serial).toEqual({ workspaceRoot: "/workspace", target: "", codebaseLearning: true });
  });
 });
