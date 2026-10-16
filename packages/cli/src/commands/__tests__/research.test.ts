import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const { managedOperationMock } = vi.hoisted(() => ({ managedOperationMock: vi.fn() }));
const runResearchMock = vi.fn();
class LinuxKernelResearchAdapterMock {}

vi.mock("@0/core", () => ({
  LinuxKernelResearchAdapter: LinuxKernelResearchAdapterMock,
  runResearch: runResearchMock,
}));

vi.mock("../../managed-operation.js", () => ({ executeManagedOperation: async (options: { execute: (context: unknown) => Promise<unknown> }) => { managedOperationMock(options); return options.execute({ signal: new AbortController().signal, deadline: Date.now() + 600_000, plan: { costCapUsd: 5 }, costLedger: {} }); } }));

const { registerResearchCommand } = await import("../research.js");

const roots: string[] = [];
let logSpy: { mockRestore(): void };

function fixture(): { kernelTree: string; reproducer: string; finding: string; artifactRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "0-research-cli-"));
  roots.push(root);
  const kernelTree = join(root, "linux");
  mkdirSync(kernelTree);
  const reproducer = join(root, "repro.c");
  writeFileSync(reproducer, "int main(void){return 0;}");
  const finding = join(root, "finding.json");
  writeFileSync(finding, JSON.stringify({
    id: "kernel-f", templateId: "kernel", title: "Kernel UAF", description: "UAF",
    severity: "high", category: "use-after-free", status: "discovered",
    evidence: { request: "", response: "" }, timestamp: 1,
  }));
  return { kernelTree, reproducer, finding, artifactRoot: join(root, "artifacts") };
}

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerResearchCommand(program);
  await program.parseAsync(["node", "0", ...args]);
}

beforeEach(() => {
  runResearchMock.mockReset();
  managedOperationMock.mockClear();
  logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  logSpy.mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("0 research linux oracle binding", () => {
  it("threads the required literal signature into the N-boot verifier", async () => {
    const files = fixture();
    runResearchMock.mockResolvedValue({ findings: [{ id: "verified" }], candidates: [], evidence: [] });
    await runCli([
      "research", "linux", "--kernel-tree", files.kernelTree, "--reproducer", files.reproducer,
      "--finding", files.finding, "--expected-signature", "KASAN: slab-use-after-free in claimed_fn",
      "--boots", "3", "--min-hits", "2", "--artifact-root", files.artifactRoot,
    ]);
    expect(runResearchMock).toHaveBeenCalledWith(
      expect.any(LinuxKernelResearchAdapterMock),
      expect.objectContaining({ config: expect.objectContaining({ verify: expect.objectContaining({
        expectedSignature: "KASAN: slab-use-after-free in claimed_fn", boots: 3, minHits: 2,
      }) }) }),
      expect.any(Object),
    );
  });

  it("retains native research evidence and finding statuses in managed run reports", async () => {
    const files = fixture();
    const finding = JSON.parse(readFileSync(files.finding, "utf8"));
    const native = { completed: true, findings: [{ finding }], candidates: [], evidence: [], warnings: [] };
    runResearchMock.mockResolvedValue(native);
    await runCli(["research", "linux", "--kernel-tree", files.kernelTree, "--reproducer", files.reproducer, "--finding", files.finding, "--expected-signature", "claimed signature"]);
    const options = managedOperationMock.mock.calls[0][0];
    const [report] = options.reports(native);
    expect(report.findings).toEqual([finding]);
    expect(report.findings[0].status).toBe("discovered");
    expect(report.summary.high).toBe(1);
  });

  it("returns a failing command when the expected signature did not reproduce", async () => {
    const files = fixture();
    runResearchMock.mockResolvedValue({ findings: [], candidates: [{ id: "hypothesis" }], evidence: [] });
    await expect(runCli([
      "research", "linux", "--kernel-tree", files.kernelTree, "--reproducer", files.reproducer,
      "--finding", files.finding, "--expected-signature", "claimed signature",
    ])).rejects.toThrow(/did not reproduce the expected signature/);
  });
});
