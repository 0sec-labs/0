import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packSarif, runUpload, type UploadDeps } from "../findings-upload.js";

const SARIF = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "0" } }, results: [] }] });
const SHA = "a".repeat(40);

function fakes(over: { statuses?: Array<{ processing_status: string; errors?: string[] }>; git?: Record<string, string> } = {}) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const statuses = [...(over.statuses ?? [{ processing_status: "complete" }])];
  const deps: UploadDeps = {
    out: vi.fn(), err: vi.fn(), sleep: async () => {}, readText: () => SARIF,
    gh: async (args, input) => {
      calls.push({ args, ...(input !== undefined ? { input } : {}) });
      if (args[0] === "repo") return "o/r\n";
      if (args[1] === "--method") return JSON.stringify({ id: "sarif-1" });
      return JSON.stringify(statuses.length > 1 ? statuses.shift() : statuses[0]);
    },
    git: async args => (args[0] === "rev-parse" && args[1] === "HEAD" ? `${SHA}\n` : args.includes("--abbrev-ref") ? "feature/x\n" : over.git?.[args.join(" ")] ?? ""),
  };
  return { deps, calls };
}

describe("0 findings upload", () => {
  // Actions sets these for every job; the tests must not depend on where they run.
  beforeEach(() => { vi.stubEnv("GITHUB_SHA", ""); vi.stubEnv("GITHUB_REF", ""); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("sends the SARIF compressed, to the repository and commit it is for, and waits until it is processed", async () => {
    const { deps, calls } = fakes({ statuses: [{ processing_status: "pending" }, { processing_status: "complete" }] });
    const result = await runUpload("scan.sarif", { wait: true }, deps);
    expect(result).toEqual({ id: "sarif-1", status: "complete" });
    const post = calls.find(call => call.args[1] === "--method")!;
    expect(post.args).toEqual(["api", "--method", "POST", "repos/o/r/code-scanning/sarifs", "--input", "-"]);
    const body = JSON.parse(post.input!);
    expect(body).toMatchObject({ commit_sha: SHA, ref: "refs/heads/feature/x" });
    expect(gunzipSync(Buffer.from(body.sarif, "base64")).toString()).toBe(SARIF);
  });

  it("does not wait with --no-wait", async () => {
    const { deps, calls } = fakes();
    expect(await runUpload("scan.sarif", { wait: false, repo: "o/r", commit: SHA, ref: "refs/pull/7/merge" }, deps)).toEqual({ id: "sarif-1", status: "pending" });
    expect(calls.some(call => call.args[1]?.startsWith("repos/o/r/code-scanning/sarifs/sarif-1"))).toBe(false);
  });

  it("reports why GitHub refused the file", async () => {
    const { deps } = fakes({ statuses: [{ processing_status: "failed", errors: ["rule id too long"] }] });
    await expect(runUpload("scan.sarif", { wait: true, repo: "o/r", commit: SHA, ref: "refs/heads/main" }, deps)).rejects.toThrow("rule id too long");
  });

  it("refuses a file that is not SARIF and values that are not a repository, a commit or a ref", async () => {
    const { deps } = fakes();
    await expect(runUpload("x", { wait: false, repo: "o/r", commit: SHA, ref: "refs/heads/main" }, { ...deps, readText: () => "{}" })).rejects.toThrow("not a SARIF");
    for (const repo of ["../x", "o/..", "./x", "o/r/extra", "o r/x"]) await expect(runUpload("x", { wait: false, repo, commit: SHA, ref: "refs/heads/main" }, deps)).rejects.toThrow("--repo");
    await expect(runUpload("x", { wait: false, repo: "o/r", commit: "abc", ref: "refs/heads/main" }, deps)).rejects.toThrow("--commit");
    await expect(runUpload("x", { wait: false, repo: "o/r", commit: SHA, ref: "main; rm -rf /" }, deps)).rejects.toThrow("--ref");
  });

  it("packSarif refuses more than GitHub accepts", () => {
    expect(() => packSarif(randomBytes(11 * 1024 * 1024).toString("base64"))).toThrow("10 MB");
  });
});
