import { describe, expect, it, vi } from "vitest";
import { executeManagedOperation, type ManagedOperationDependencies } from "./managed-operation.js";
function fixture() {
  let status = "queued";
  const store = {
    createExecutionFromSnapshot: vi.fn(() => ({ id: "run-one" })),
    updateExecution: vi.fn((_id: string, update: { status?: string }) => { status = update.status ?? status; }),
    getExecution: vi.fn(() => ({ status })), saveExecutionResults: vi.fn(), close: vi.fn(),
  };
  return { store, dependencies: { store: vi.fn(() => store) } as unknown as ManagedOperationDependencies };
}
describe("managed CLI operations", () => {
  it("runs one operation once, preserves semantic verdicts, and retains CLI-owned history", async () => {
    const { store, dependencies } = fixture();
    const value = { result: { status: "not_reproduced", evidence_kind: "source-only" }, exitCode: 1 };
    const execute = vi.fn(async () => {
      expect(store.createExecutionFromSnapshot).toHaveBeenCalledWith(expect.objectContaining({ target: "finding.json", name: "Finding verification" }), "cli");
      return value;
    });
    const result = await executeManagedOperation({ type: "verify", name: "Finding verification", target: "finding.json", timeCapMs: 30_000, execute, output: outcome => outcome.result }, dependencies);
    expect(result).toBe(value);
    expect(execute).toHaveBeenCalledOnce();
    expect(store.saveExecutionResults).toHaveBeenCalledWith("run-one", expect.objectContaining({ status: "completed", outputs: [{ nodeId: "operation", outputs: [{ kind: "verification-result", value: value.result }] }] }));
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("retains infrastructure failures and never disguises an engine error as a semantic verdict", async () => {
    const { store, dependencies } = fixture();
    await expect(executeManagedOperation({ type: "fix", name: "Source fix", target: "/repo", timeCapMs: 30_000,
      execute: async () => { throw new Error("provider disconnected"); } }, dependencies)).rejects.toThrow("provider disconnected");
    expect(store.saveExecutionResults).toHaveBeenCalledWith("run-one", expect.objectContaining({ status: "failed" }));
    expect(store.updateExecution).toHaveBeenCalledWith("run-one", expect.objectContaining({ status: "failed" }));
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("preserves an engine's error result for the command's established JSON and exit mapping", async () => {
    const { store, dependencies } = fixture();
    const value = { status: "error", error: "replay failed" };
    const result = await executeManagedOperation({ type: "verify", name: "Finding verification", target: "finding.json", timeCapMs: 30_000, execute: async () => value, status: () => "failed" }, dependencies);
    expect(result).toBe(value);
    expect(store.saveExecutionResults).toHaveBeenCalledWith("run-one", expect.objectContaining({ status: "failed" }));
  });

  it("reports retention failure while keeping the actual execution status", async () => {
    const { store, dependencies } = fixture();
    store.saveExecutionResults.mockImplementation(() => { throw new Error("disk full"); });
    await expect(executeManagedOperation({ type: "verify", name: "Finding verification", target: "finding.json", timeCapMs: 30_000, execute: async () => ({ status: "reproduced" }) }, dependencies)).rejects.toThrow("result retention failed: disk full");
    expect(store.updateExecution).toHaveBeenLastCalledWith("run-one", expect.objectContaining({ status: "completed", error: "Run completed, but result retention failed: disk full" }));
  });
});
