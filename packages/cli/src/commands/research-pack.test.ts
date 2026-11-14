import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { isCoreEdition, loadResearchPack, researchPackUnavailableMessage } from "./research-pack.js";
import { registerIdentityCommand } from "./identity.js";
import { registerAdGraphCommand } from "./adgraph.js";
import { registerEntraGraphCommand } from "./entragraph.js";
import { registerXnuFuzzCommand } from "./xnu-fuzz.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("research packs under ZERO_EDITION=core", () => {
  it("defaults to the full edition", () => {
    expect(isCoreEdition({})).toBe(false);
    expect(isCoreEdition({ ZERO_EDITION: "full" })).toBe(false);
    expect(isCoreEdition({ ZERO_EDITION: "core" })).toBe(true);
  });

  it("does not run the loader and names the pack", async () => {
    vi.stubEnv("ZERO_EDITION", "core");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const loader = vi.fn(async () => ({}));
    expect(await loadResearchPack("adgraph", loader)).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(`${researchPackUnavailableMessage("adgraph")}\n`);
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["identity", (p: Command) => registerIdentityCommand(p), ["identity", "--tenant", "t"]],
    ["entragraph", (p: Command) => registerEntraGraphCommand(p), ["entragraph", "--input", "/nonexistent"]],
    ["adgraph", (p: Command) => registerAdGraphCommand(p), ["adgraph", "--input", "/nonexistent"]],
    ["xnu-fuzz", (p: Command) => registerXnuFuzzCommand(p), ["xnu-fuzz", "gen", "--model", "/nonexistent"]],
  ] as const)("lazy command %s prints the full-edition message", async (pack, register, argv) => {
    vi.stubEnv("ZERO_EDITION", "core");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command().exitOverride();
    register(program);
    await program.parseAsync(argv as unknown as string[], { from: "user" });
    const out = [...write.mock.calls.map((c) => String(c[0])), ...err.mock.calls.map((c) => String(c[0]))].join("");
    expect(out).toContain(`This command is part of the full edition (research pack: ${pack}).`);
  });
});
