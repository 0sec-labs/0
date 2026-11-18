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
    expect(vi.mocked(deps.err).mock.calls[0]![0]).toBe("No console running. Start one with: 0 --headless");
    expect(vi.mocked(deps.out)).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1); process.exitCode = 0;
    await program.parseAsync(["threads", "list", "--format", "json"], { from: "user" });
    expect(JSON.parse(vi.mocked(deps.err).mock.calls[1]![0])).toEqual({ error: "No console running. Start one with: 0 --headless" });
  });
  it("renders sessions and automation definitions as readable text without changing JSON defaults", async () => {
    const { runtime, deps } = setup();
    runtime.getSession = vi.fn(() => ({ session: { id: "chat-1", status: "ready" }, pendingDecisions: [] }));
    const program = new Command(); registerWorkflowCommand(program, deps);
    for (const args of [["threads", "show", "chat-1"], ["automation", "show", "saved"]]) {
      await program.parseAsync([...args, "--format", "text"], { from: "user" });
    }
    const outputs = vi.mocked(deps.out).mock.calls.map(([text]) => text);
    expect(outputs[0]).toContain("chat-1  ready");
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
    await program.parseAsync(["threads", "force-stop", "live", "--engine-url", "http://127.0.0.1:48123", "--engine-token-env", "OPERATOR_TOKEN", "--format", "json"], { from: "user" });
    expect(runtime.forceStopSession).toHaveBeenCalledExactlyOnceWith("live");
    expect(runtime.cancelSession).not.toHaveBeenCalled();
    expect(deps.createRuntime).not.toHaveBeenCalled(); expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(deps.out).mock.calls[0]![0])).toEqual({ session: { id: "live", status: "ready" } });
  });
  it("reports unsupported transports instead of simulating cancellation", async () => {
    const { runtime, deps } = setup(); runtime.cancelSession = vi.fn(); deps.createRemoteRuntime = vi.fn(async () => runtime);
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "force-stop", "live", "--backend", "remote"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(deps.err).toHaveBeenCalledWith("The selected engine does not expose operator force stop; no work was changed.");
    expect(runtime.cancelSession).not.toHaveBeenCalled(); expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});

describe("threads read and wait", () => {
  const snapshot = (status: string, reply?: string) => ({ session: { id: "t1", status, title: "Login flow", workspacePath: "/repo" }, usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 }, messages: reply ? [{ role: "assistant", content: [{ type: "text", text: reply }] }] : [] });
  it("show prints the status line, the last reply and usage by default, and JSON with --format json", async () => {
    const { runtime, deps } = setup();
    runtime.getSession = vi.fn(() => snapshot("ready", "The answer."));
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "show", "t1"], { from: "user" });
    expect(vi.mocked(deps.out).mock.calls[0]![0]).toMatch(/^t1  ready  "Login flow"  \/repo\n\nThe answer\.\n\nUsage: 3 input tokens, 2 output tokens, cost \$0\.0100$/);
    await program.parseAsync(["threads", "show", "t1", "--format", "json"], { from: "user" });
    expect(JSON.parse(vi.mocked(deps.out).mock.calls[1]![0]).session.id).toBe("t1");
  });
  it("send --wait waits for the turn and prints only the reply on stdout", async () => {
    const { runtime, deps } = setup();
    runtime.sendMessage = vi.fn();
    const states = [snapshot("working"), snapshot("working"), snapshot("ready", "Done.")];
    runtime.getSession = vi.fn(() => states.shift());
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "send", "t1", "more", "--wait"], { from: "user" });
    expect(runtime.sendMessage).toHaveBeenCalledWith("t1", "more");
    expect(vi.mocked(deps.out).mock.calls).toEqual([["Done."]]);
    expect(vi.mocked(deps.err).mock.calls[0]![0]).toContain("thread t1 ready");
    expect(process.exitCode ?? 0).toBe(0);
  });
  it("show --wait times out with the command that reads it later, exit 1", async () => {
    const { runtime, deps } = setup();
    runtime.getSession = vi.fn(() => snapshot("working"));
    const program = new Command(); registerWorkflowCommand(program, deps);
    await program.parseAsync(["threads", "show", "t1", "--wait", "--timeout", "0.001"], { from: "user" });
    expect(vi.mocked(deps.err).mock.calls[0]![0]).toContain("0 threads show t1");
    expect(process.exitCode).toBe(1);
  });
});
