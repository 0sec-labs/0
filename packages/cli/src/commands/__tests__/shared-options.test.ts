import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automationsOption, chatOption, engineOptions } from "../shared-options.js";

function parse(argv: string[], required = false): Record<string, unknown> {
  const program = new Command().exitOverride();
  const command = program.command("x").allowUnknownOption(false);
  engineOptions(command);
  chatOption(command, "chat", required);
  automationsOption(command, "automations");
  let seen: Record<string, unknown> = {};
  command.action((options: Record<string, unknown>) => { seen = options; });
  program.parse(["node", "0", "x", ...argv]);
  return seen;
}

describe("shared engine, chat and automations options", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts the current spellings", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(parse(["--engine", "e1", "--engines-config", "/p.json", "--chat", "c1", "--automations"])).toMatchObject({ engine: "e1", enginesConfig: "/p.json", chat: "c1", automations: true });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("keeps --backend working as a hidden alias of --engine", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(parse(["--backend=e2"])).toMatchObject({ engine: "e2" });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--backend is deprecated; use --engine"));
  });

  it("keeps --backends-config working as a hidden alias of --engines-config", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(parse(["--backends-config", "/old.json"])).toMatchObject({ enginesConfig: "/old.json" });
  });

  it("keeps --session working as a hidden alias of --chat, including when required", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(parse(["--session", "c2"], true)).toMatchObject({ chat: "c2" });
    expect(() => parse([], true)).toThrow(/--chat/);
  });

  it("keeps --workflows working as a hidden alias of --automations", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(parse([])).toMatchObject({ automations: false });
    expect(parse(["--workflows"])).toMatchObject({ automations: true });
  });

  it("hides the legacy spellings from help", () => {
    const command = new Command("x");
    engineOptions(command); chatOption(command, "chat"); automationsOption(command, "automations");
    const help = command.helpInformation();
    expect(help).toContain("--engine <id>");
    expect(help).not.toMatch(/--backend|--session|--workflows/);
  });
});
