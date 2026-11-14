import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const execution = vi.hoisted(() => vi.fn());
const runtimeConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../run.js", () => ({ runUnified: execution }));
vi.mock("@0/engine", async () => ({
  ...await vi.importActual<{ validateCyberAccessProgram: (value: unknown) => unknown }>("../../../../engine/src/runtime/cyber-access-program.js"),
  getScopeEnforcementState: () => { throw new Error("Scope/target work must not start"); },
  createNativeApiRuntime: (config: Record<string, unknown>) => { runtimeConfigs.push(config); return { getConfigurationDiagnostics: () => ({ valid: true }) }; },
  LlmApiRuntime: class { constructor(config: Record<string, unknown>) { runtimeConfigs.push(config); } getConfigurationDiagnostics() { return { valid: true }; } },
}));
const { registerScanCommand } = await import("../scan.js");
const { registerReviewCommand } = await import("../review.js");

function command(kind: "scan" | "review", runtime?: string, program = "daybreak_blue", provider?: string) {
  const cli = new Command().exitOverride();
  registerScanCommand(cli); registerReviewCommand(cli);
  return cli.parseAsync([kind, ...(kind === "scan" ? ["--target", "https://example.invalid"] : ["/does-not-exist"]), "--cyber-access-program", program, ...(runtime ? ["--runtime", runtime] : []), ...(provider ? ["--provider", provider] : [])], { from: "user" });
}

beforeEach(() => { execution.mockClear(); runtimeConfigs.length = 0; });

describe("explicit access-program selection pins the supported public API route", () => {
  it.each(["scan", "review"] as const)("rejects unsupported managed %s without target or provider work", async kind => {
    for (const program of ["standard", "daybreak_blue", "daybreak_red"]) {
      await expect(command(kind, "codex", program)).rejects.toThrow("requires explicit --runtime api --provider openai");
    }
    expect(execution).not.toHaveBeenCalled();
  });
  it.each([undefined, "auto", "api", "claude"])("never switches from runtime %s to select a program", async runtime => {
    await expect(command("review", runtime)).rejects.toThrow("requires explicit --runtime api --provider openai");
    expect(execution).not.toHaveBeenCalled();
  });
  it("rejects invalid program spellings independently of model choice", async () => {
    await expect(command("review", "codex", "gpt-daybreak-blue-latest")).rejects.toThrow("Invalid cyber access program");
    expect(execution).not.toHaveBeenCalled();
  });
  it("does not infer program selection from a model alias", async () => {
    const cli = new Command().exitOverride(); registerReviewCommand(cli);
    await cli.parseAsync(["review", "/does-not-exist", "--runtime", "codex", "--model", "gpt-daybreak-blue-latest"], { from: "user" });
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-daybreak-blue-latest", runtime: "codex" }));
    expect(execution.mock.calls[0]?.[0]).not.toHaveProperty("cyberAccessProgram");
  });

  it.each(["standard", "daybreak_blue", "daybreak_red"])("forwards explicit public API program %s without changing its model", async program => {
    await command("review", "api", program, "openai");
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ runtime: "api", provider: "openai", cyberAccessProgram: program }));
  });
  it("refuses API mode without an explicit provider", async () => {
    await expect(command("review", "api")).rejects.toThrow("requires explicit --runtime api --provider openai");
    expect(execution).not.toHaveBeenCalled();
  });

  it("rejects unsupported providers before target work", async () => {
    await expect(command("review", "api", "daybreak_blue", "anthropic")).rejects.toThrow("no provider or account was switched");
    expect(execution).not.toHaveBeenCalled();
  });

  it("validates the explicit API key and model without switching credential selection", async () => {
    const cli = new Command().exitOverride(); registerReviewCommand(cli);
    await cli.parseAsync(["review", "/does-not-exist", "--runtime", "api", "--provider", "openai", "--model", "gpt-fixture", "--api-key", "synthetic-project-key", "--cyber-access-program", "daybreak_blue"], { from: "user" });
    expect(runtimeConfigs).toContainEqual(expect.objectContaining({ provider: "openai", apiKey: "synthetic-project-key", model: "gpt-fixture", cyberAccessProgram: "daybreak_blue" }));
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", apiKey: "synthetic-project-key", model: "gpt-fixture", cyberAccessProgram: "daybreak_blue" }));
  });

  it("preserves explicit ChatGPT subscription selection without coercing an API key", async () => {
    await command("review", "api", "daybreak_blue", "chatgpt-codex");
    expect(runtimeConfigs).toContainEqual(expect.objectContaining({ provider: "chatgpt-codex", cyberAccessProgram: "daybreak_blue" }));
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ runtime: "api", provider: "chatgpt-codex", cyberAccessProgram: "daybreak_blue" }));
  });
  it("rejects API-key coercion on the ChatGPT OAuth route", async () => {
    const cli = new Command().exitOverride(); registerReviewCommand(cli);
    await expect(cli.parseAsync(["review", "/does-not-exist", "--runtime", "api", "--provider", "chatgpt-codex", "--api-key", "synthetic", "--cyber-access-program", "daybreak_blue"], { from: "user" })).rejects.toThrow("existing ChatGPT OAuth account, not --api-key");
    expect(execution).not.toHaveBeenCalled();
  });

});
