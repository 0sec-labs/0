import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowCommand, type WorkflowCliRuntime, type WorkflowCommandDeps } from "../workflow.js";

function setup() {
  const runtime: WorkflowCliRuntime = {
    listTemplates: vi.fn(() => [{ id: "repository-review" }]), getTemplate: vi.fn(() => ({ id: "repository-review" })),
    listWorkflows: vi.fn(() => []), getWorkflow: vi.fn(() => ({ id: "saved", target: "/repo", revision: 4 })),
    dispose: vi.fn(),
  };
  const deps: WorkflowCommandDeps = { createRuntime: vi.fn(async () => runtime), out: vi.fn(), err: vi.fn(), sleep: vi.fn(async () => {}) };
  return { runtime, deps };
}
afterEach(() => { process.exitCode = 0; });
describe("workflow CLI", () => {
  it("thread commands need a running console: no private in-process fallback, one clear message, non-zero exit", async () => {
    const { deps } = setup();
    vi.mocked(deps.createRuntime).mockRejectedValue(new Error("No console running. Start one with: 0 --headless"));
    const program = new Command(); registerWorkflowCommand(program, deps);
    process.exitCode = 0;
    await program.parseAsync(["threads", "list"], { from: "user" });
    expect(deps.createRuntime).toHaveBeenCalledWith(expect.objectContaining({ requireEngine: true }));
    expect(JSON.parse(vi.mocked(deps.err).mock.calls[0]![0])).toEqual({ error: "No console running. Start one with: 0 --headless" });
    expect(vi.mocked(deps.out)).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2); process.exitCode = 0;
  });
  it("renders sessions and automation definitions as readable text without changing JSON defaults", async () => {
    const { runtime, deps } = setup();
    runtime.getSession = vi.fn(() => ({ session: { id: "chat-1", status: "ready" }, pendingDecisions: [] }));
    const program = new Command(); registerWorkflowCommand(program, deps);
    for (const args of [["threads", "show", "chat-1"], ["automation", "show", "saved"]]) {
      await program.parseAsync([...args, "--format", "text"], { from: "user" });
    }
    const outputs = vi.mocked(deps.out).mock.calls.map(([text]) => text);
    expect(outputs[0]).toContain("Session:\n  Id: chat-1");
    expect(outputs[1]).toContain("Target: /repo");
    for (const text of outputs) expect(() => JSON.parse(text)).toThrow();
    const defaultsProgram = new Command(); registerWorkflowCommand(defaultsProgram, deps);
    await defaultsProgram.parseAsync(["automation", "show", "saved"], { from: "user" });
    expect(JSON.parse(vi.mocked(deps.out).mock.calls[2]![0])).toEqual({ id: "saved", target: "/repo", revision: 4 });
  });
  it("uses engine session lifecycle methods and keeps disconnect separate from cancellation", async () => {
    const { runtime, deps } = setup();
    runtime.listSessions = vi.fn(() => [{ id: "web-session" }]);
    runtime.getSession = vi.fn(() => ({ id: "web-session" }));
    runtime.continueSession = vi.fn();
    runtime.cancelSession = vi.fn();
    runtime.getSessionEvents = vi.fn(() => []);
    deps.createRemoteRuntime = vi.fn(async () => runtime);
    for (const args of [["list"], ["show", "web-session"], ["continue", "web-session", "continue"], ["events", "web-session", "--after", "0"]]) {
      const program = new Command(); registerWorkflowCommand(program, deps);
      await program.parseAsync(["threads", ...args, "--backend", "engine"], { from: "user" });
    }
    expect(runtime.listSessions).toHaveBeenCalledOnce();
    expect(runtime.getSession).toHaveBeenCalledWith("web-session");
    expect(runtime.continueSession).toHaveBeenCalledWith("web-session", "continue");
    expect(runtime.getSessionEvents).toHaveBeenCalledWith("web-session", 0);
    expect(runtime.cancelSession).not.toHaveBeenCalled();
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "cancel", "web-session", "--backend", "engine"], { from: "user" });
    expect(runtime.cancelSession).toHaveBeenCalledWith("web-session");
    expect(deps.createRuntime).not.toHaveBeenCalled();
  });
  it("lists threads as a table with --format text", async () => {
    const { runtime, deps } = setup();
    runtime.listSessions = vi.fn(() => [{ id: "t-1", status: "ready", title: "Fix the\nbuild", workspacePath: "/repo" }, { id: "t-2", status: "running", workspacePath: "/repo" }]);
    deps.createRemoteRuntime = vi.fn(async () => runtime);
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "list", "--format", "text", "--backend", "engine"], { from: "user" });
    const printed = vi.mocked(deps.out).mock.calls.map(call => String(call[0])).join("\n");
    expect(printed).toMatch(/^ID\s+STATUS\s+TITLE\s+FOLDER/);
    expect(printed).toContain("t-1  ready");
    expect(printed).toContain("Fix the build");
    expect(printed).toContain("Untitled");
  });
  it("exposes template and saved automation discovery through commander", async () => {
    const { runtime, deps } = setup();
    const program = new Command();
    registerWorkflowCommand(program, deps);
    await program.parseAsync(["automation", "list", "--templates"], { from: "user" });
    expect(runtime.listTemplates).toHaveBeenCalledOnce();
    expect(runtime.listWorkflows).not.toHaveBeenCalled();
  });
  it("has no run or runs commands any more", () => {
    const program = new Command();
    registerWorkflowCommand(program, setup().deps);
    expect(program.commands.map(command => command.name()).sort()).toEqual(["automation", "threads"]);
    expect(program.commands.find(command => command.name() === "automation")!.commands.map(command => command.name()).sort()).toEqual(["list", "show"]);
  });
});
describe("explicit operator force-stop command", () => {
  it("dispatches only the selected force-stop action and prints the owning engine result", async () => {
    const { runtime, deps } = setup();
    runtime.forceStopSession = vi.fn(async () => ({ session: { id: "live", status: "ready" } }));
    runtime.cancelSession = vi.fn(); deps.createRemoteRuntime = vi.fn(async () => runtime);
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "force-stop", "live", "--engine-url", "http://127.0.0.1:48123", "--engine-token-env", "OPERATOR_TOKEN"], { from: "user" });
    expect(runtime.forceStopSession).toHaveBeenCalledExactlyOnceWith("live");
    expect(runtime.cancelSession).not.toHaveBeenCalled();
    expect(deps.createRuntime).not.toHaveBeenCalled(); expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(deps.out).mock.calls[0]![0])).toEqual({ session: { id: "live", status: "ready" } });
  });
  it("reports unsupported transports instead of simulating cancellation", async () => {
    const { runtime, deps } = setup(); runtime.cancelSession = vi.fn(); deps.createRemoteRuntime = vi.fn(async () => runtime);
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "force-stop", "live", "--backend", "remote"], { from: "user" });
    expect(process.exitCode).toBe(2);
    expect(deps.err).toHaveBeenCalledWith(JSON.stringify({ error: "The selected engine does not expose operator force stop; no work was changed." }));
    expect(runtime.cancelSession).not.toHaveBeenCalled(); expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
