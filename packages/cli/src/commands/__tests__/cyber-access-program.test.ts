import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const execution = vi.hoisted(() => vi.fn());
vi.mock("../run.js", () => ({ runUnified: execution }));
vi.mock("@0/core", async () => ({
  ...await vi.importActual<{ validateCyberAccessProgram: (value: unknown) => unknown }>("../../../../core/src/runtime/cyber-access-program.js"),
  getScopeEnforcementState: () => { throw new Error("Scope/target work must not start"); },
}));
const { registerScanCommand } = await import("../scan.js");
const { registerReviewCommand } = await import("../review.js");

function command(kind: "scan" | "review", runtime?: string, program = "daybreak_blue") {
  const cli = new Command().exitOverride();
  registerScanCommand(cli); registerReviewCommand(cli);
  return cli.parseAsync([kind, ...(kind === "scan" ? ["--target", "https://example.invalid"] : ["/does-not-exist"]), "--cyber-access-program", program, ...(runtime ? ["--runtime", runtime] : [])], { from: "user" });
}

beforeEach(() => execution.mockClear());

describe("explicit cyber access intent fails closed before assessment startup", () => {
  it.each(["scan", "review"] as const)("rejects unsupported managed %s without target or provider work", async kind => {
    for (const program of ["standard", "daybreak_blue", "daybreak_red"]) {
      await expect(command(kind, "codex", program)).rejects.toThrow("not supported by managed scan/review or the direct ChatGPT subscription backend");
    }
    expect(execution).not.toHaveBeenCalled();
  });
  it.each([undefined, "auto", "api", "claude"])("never switches from runtime %s to select a program", async runtime => {
    await expect(command("review", runtime)).rejects.toThrow("requires explicit --runtime codex");
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

});
