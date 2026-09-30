import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolExecutor } from "./tools.js";

describe("scoped command pipeline output", () => {
  it("retains report headers and final evidence inside the original byte budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-pipeline-output-"));
    const executor = new ToolExecutor({ target: root, scanId: "pipeline-output", scopePath: root, role: "verify", autonomyMode: "standard", findings: [], attackResults: [], targetInfo: {} }, null);
    try {
      writeFileSync(join(root, "report.txt"), "HEADER=owned-report\n" + "padding\n".repeat(2200) + "VERDICT=tail-evidence\n");
      const result = await executor.execute({ name: "run_command", arguments: { command: "cat report.txt" } });
      expect(result.success).toBe(true);
      expect(String(result.output)).toContain("HEADER=owned-report");
      expect(String(result.output)).toContain("VERDICT=tail-evidence");
      expect(String(result.output)).toContain("truncated");
      expect(Buffer.byteLength(String(result.output))).toBeLessThanOrEqual(10_000);
      const downstream = await executor.execute({ name: "run_command", arguments: { command: "cat report.txt | tail -1" } });
      expect(downstream.output).toBe("VERDICT=tail-evidence\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("preserves the actual final failure instead of returning only preceding stdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-pipeline-error-"));
    const executor = new ToolExecutor({ target: root, scanId: "pipeline-error", scopePath: root, role: "verify", autonomyMode: "standard", findings: [], attackResults: [], targetInfo: {} }, null);
    try {
      writeFileSync(join(root, "report.txt"), "START\n" + "padding\n".repeat(2200));
      const result = await executor.execute({ name: "run_command", arguments: { command: "cat report.txt absent-evidence.txt" } });
      expect(result.success).toBe(false);
      expect(result.error).toContain("START");
      expect(result.error).toContain("absent-evidence.txt");
      expect(Buffer.byteLength(result.error!)).toBeLessThanOrEqual(2_000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
