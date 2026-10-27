import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerThemeCommand } from "../theme.js";
import { registerTuiCommand } from "../tui.js";
import { registerAuditCommand } from "../audit.js";
import { registerScanCommand } from "../scan.js";
import { registerReviewCommand } from "../review.js";

vi.mock("../run.js", () => ({ runUnified: vi.fn() }));

describe("command interface without terminal rendering", () => {
  const exitCode = process.exitCode;
  afterEach(() => { process.exitCode = exitCode; vi.restoreAllMocks(); });
  it.each(["tui", "watch"])("keeps %s as a hidden actionable migration notice", async name => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command(); registerTuiCommand(program);
    expect(program.helpInformation()).not.toMatch(/\btui\b|\bwatch\b/);
    await program.parseAsync([name], { from: "user" });
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Run 0 web"));
    expect(process.exitCode).toBe(2);
  });
  it("does not expose terminal theme editing", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command(); registerThemeCommand(program);
    expect(program.helpInformation()).not.toMatch(/\btheme\b/);
    await program.parseAsync(["theme", "apply", "dark"], { from: "user" });
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Settings → Appearance"));
    expect(process.exitCode).toBe(1);
  });
  it.each([
    { name: "scan", register: registerScanCommand, target: ["--target", "https://example.com"] },
    { name: "audit", register: registerAuditCommand, target: ["express"] },
    { name: "review", register: registerReviewCommand, target: ["."] },
  ])("$name rejects the removed --tui flag before starting work", async ({ name, register, target }) => {
    const program = new Command().exitOverride().configureOutput({ writeErr() {} }); register(program);
    expect(program.commands[0].helpInformation()).not.toContain("--tui");
    await expect(program.parseAsync([name, ...target, "--tui"], { from: "user" })).rejects.toMatchObject({ code: "commander.unknownOption" });
  });
});
