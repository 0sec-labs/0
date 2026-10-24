import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoutingCommand } from "../routing.js";

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
const plan = { mode: "fixture", models: ["gpt-4o-mini", "gpt-4o"], repeats: 2, maxCalls: 64, costCapUsd: 1, timeCapMs: 10_000, authorizationRef: "fixture only", workflow: { targetKind: "web", goal: "unknown-vulnerabilities", depth: "quick" } };
const cli = async (args: string[]) => { const program = new Command(); program.exitOverride(); registerRoutingCommand(program); await program.parseAsync(["node", "0", "routing-qualify", ...args]); };

describe("real routing qualification command", () => {
  it("runs every bounded task and negative control and persists one complete aggregate usage report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "routing-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const input = join(directory, "plan.json"); const output = join(directory, "report.json");
      writeFileSync(input, JSON.stringify(plan));
      await cli(["--plan", input, "--out", output, "--regress-model", "gpt-4o"]);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report.totalCalls).toBe(64);
      expect(report.status).toBe("completed-for-review");
      expect(report.trials).toHaveLength(32);
      expect(report.trials.filter((t: { model: string }) => t.model === "gpt-4o").every((t: { status: string }) => t.status === "failed")).toBe(true);
      expect(report.trials.filter((t: { model: string }) => t.model === "gpt-4o-mini").every((t: { status: string }) => t.status === "passed")).toBe(true);
      expect(report.actualProviderChargeUsd).toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("actual provider charge unknown"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("refuses a paid model-api plan without explicit dispatch authorization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "routing-cli-no-dispatch-"));
    try {
      const input = join(directory, "plan.json"); const output = join(directory, "report.json");
      writeFileSync(input, JSON.stringify({ ...plan, mode: "model-api" }));
      await expect(cli(["--plan", input, "--out", output])).rejects.toThrow(/no provider request sent/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
