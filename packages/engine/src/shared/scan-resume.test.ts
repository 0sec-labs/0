import { describe, expect, it } from "vitest";
import { resolvePersistedScanResume, ScanResumeRequestSchema } from "./scan-resume.js";
const scan = (target: string, mode = "deep") => ({ id: "scan-1", depth: "deep", mode, target });
describe("persisted scan resume", () => {
  it("retains CLI URL/source/package routing and original scan mode/depth", () => {
    expect(resolvePersistedScanResume(scan("repo:/engine/repo"))).toMatchObject({ target: "/engine/repo", targetType: "source-code", depth: "deep", mode: "deep" });
    expect(resolvePersistedScanResume(scan("npm:@scope/pkg@1.2.3"))).toMatchObject({ target: "@scope/pkg", targetType: "npm-package", packageVersion: "1.2.3" });
    expect(resolvePersistedScanResume(scan("npm:@scope/pkg"))).toMatchObject({ target: "@scope/pkg", targetType: "npm-package" });
    expect(resolvePersistedScanResume(scan("web:https://app.test", "probe"))).toMatchObject({ target: "https://app.test", targetType: "web-app", mode: "web" });
    expect(resolvePersistedScanResume(scan("mcp://server", "probe"))).toMatchObject({ target: "mcp://server", mode: "mcp" });
    expect(resolvePersistedScanResume(scan("scan:https://app.test", "web"))).toMatchObject({ target: "https://app.test", targetType: "web-app", mode: "web" });
  });
  it("recognizes current persisted package ecosystems without rewriting engine paths", () => {
    expect(resolvePersistedScanResume(scan("pypi:requests@2"))).toMatchObject({ target: "requests", targetType: "pypi-package", packageVersion: "2" });
    expect(resolvePersistedScanResume(scan("cargo:serde@1"))).toMatchObject({ targetType: "cargo-package" });
    expect(resolvePersistedScanResume(scan("oci:registry/image@sha256:abc"))).toMatchObject({ target: "registry/image", packageVersion: "sha256:abc", targetType: "oci-image" });
    expect(resolvePersistedScanResume(scan("repo:C:\\engine\\repo"))).toMatchObject({ target: "C:\\engine\\repo" });
  });
  it("rejects conversations, malformed targets and unsupported persisted settings", () => {
    for (const input of [{ ...scan("https://app.test"), id: "console-123" }, scan("repo:"), scan("npm:pkg@"), scan("unknown-target"), { ...scan("https://app.test"), depth: "forever" }, scan("https://app.test", "conversation")]) expect(() => resolvePersistedScanResume(input)).toThrow();
  });
  it("validates integer branching and bounded limits without client authority overrides", () => {
    expect(ScanResumeRequestSchema.parse({ sessionId: "session-1", approval: "launch-authorized-run", branchFromEntry: 0 })).toMatchObject({ branchFromEntry: 0 });
    for (const override of [{ branchFromEntry: -1 }, { branchFromEntry: 0.5 }, { timeCapMs: 0 }, { costCapUsd: 1001 }, { target: "/other" }, { model: "other" }, { dbPath: "/other.db" }]) expect(() => ScanResumeRequestSchema.parse({ sessionId: "session-1", approval: "launch-authorized-run", ...override })).toThrow();
  });
});
