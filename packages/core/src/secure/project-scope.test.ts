import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const pipeline = vi.hoisted(() => vi.fn());
vi.mock("../unified-pipeline.js", () => ({ runPipeline: pipeline }));
import { runSecureProject } from "./project.js";
import { getLocalSourceBoundary } from "../scope/local-source-boundary.js";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); pipeline.mockReset(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "0-project-scope-")); directories.push(directory);
  const repo = join(directory, "repo"); mkdirSync(join(repo, "service"), { recursive: true });
  writeFileSync(join(repo, "service/app.ts"), "export const value = 1;\n"); writeFileSync(join(repo, "outside.ts"), "export const other = 2;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
  return { repo, stateDir: join(directory, "state"), revision: git("rev-parse", "HEAD") };
}

it("investigates the exact pinned checkout folder and records scope for resume", async () => {
  const f = fixture(); pipeline.mockImplementation(async (options) => {
    expect(getLocalSourceBoundary()).toBe(realpathSync(options.target));
    return { findings: [], researchFailed: false };
  });
  const result = await runSecureProject({ ...f, repoRoot: f.repo, sourcePath: "service", testCommand: "true", runtime: "api" });
  expect(result.status).toBe("completed"); expect(result.revision).toBe(f.revision); expect(result.sourcePath).toBe("service");
  expect(pipeline.mock.calls[0][0].target).toBe(realpathSync(join(f.stateDir, "checkout/service")));
  const state = JSON.parse(readFileSync(join(f.stateDir, "state.json"), "utf8"));
  expect(state.identity.sourcePath).toBe("service");
  state.status = "failed"; state.phase = "complete"; writeFileSync(join(f.stateDir, "state.json"), JSON.stringify(state));
  const resumed = await runSecureProject({ ...f, repoRoot: f.repo, sourcePath: ".", testCommand: "true", runtime: "api", resume: true });
  expect(resumed.status).toBe("blocked"); expect(resumed.errors.join(" ")).toContain("Config mismatch");
  expect(pipeline).toHaveBeenCalledTimes(1);
});

it("refuses a missing folder before investigation and keeps the whole-tree default", async () => {
  const f = fixture(); pipeline.mockResolvedValue({ findings: [] });
  const missing = await runSecureProject({ ...f, repoRoot: f.repo, sourcePath: "missing", testCommand: "true" });
  expect(missing.status).toBe("failed"); expect(pipeline).not.toHaveBeenCalled();
  const whole = await runSecureProject({ ...f, repoRoot: f.repo, testCommand: "true" });
  expect(whole.status).toBe("completed"); expect(pipeline.mock.calls[0][0].target).toBe(realpathSync(join(f.stateDir, "checkout")));
});
