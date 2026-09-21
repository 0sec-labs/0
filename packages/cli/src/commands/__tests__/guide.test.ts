import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAuthCommand } from "../auth.js";
import { registerConnectCommand } from "../connect.js";
import { registerGuideCommand } from "../guide.js";

beforeEach(() => {
  vi.stubEnv("ZERO_CLOUD_TOKEN", "test-only-token");
  vi.stubEnv("ZERO_CLOUD_HOST", "https://cloud.0.security");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ok" }))));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function program() {
  const cli = new Command().name("0sec").exitOverride();
  registerGuideCommand(cli);
  // Registration after guide must still appear in discovery at invocation time.
  registerAuthCommand(cli);
  registerConnectCommand(cli);
  return cli;
}

async function guide(...args: string[]) {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await program().parseAsync(["guide", ...args], { from: "user" });
  return output.mock.calls.map(([chunk]) => String(chunk)).join("");
}

describe("agent guide discovery", () => {
  it("keeps account access unknown even when health accepts a token", async () => {
    const result = JSON.parse(await guide("--json"));
    expect(result.states.service.status).toBe("ok");
    expect(result.states.account.status).toBe("unknown");
    expect(result.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "hosted-inference", layer: "service", requiresAuth: true }),
      expect.objectContaining({ id: "connect", layer: "service" }),
    ]));
  });

  it("discovers registered nested commands and their actual arguments", async () => {
    const result = JSON.parse(await guide("commands", "--json"));
    const connect = result.commands.find((command: { name: string }) => command.name === "connect");
    expect(connect.arguments).toContainEqual(expect.objectContaining({ name: "repo", required: false }));
    expect(connect.options).toContainEqual(expect.objectContaining({ flags: "--yes" }));
    const login = result.commands.find((command: { name: string }) => command.name === "auth login");
    expect(login.options).toContainEqual(expect.objectContaining({ flags: "--token <value>" }));
  });

  it("returns only the requested command contract in JSON topic mode", async () => {
    const output = await guide("auth login", "--json");
    const result = JSON.parse(output);
    expect(result.commands.map((command: { name: string }) => command.name)).toEqual(["auth login"]);
    expect(result.capabilities).toEqual([]);
    expect(output).not.toContain("test-only-token");
  });

  it("rejects unknown JSON topics before making a service request", async () => {
    await expect(guide("not-a-command", "--json")).rejects.toMatchObject({ code: "commander.invalidArgument" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
