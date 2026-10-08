import { mkdtempSync, readFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTeamCommand } from "../team.js";
import { TeamAuth, type TeamConfig } from "../../web/team-auth.js";
let directory: string; let config: string; let priorExitCode: typeof process.exitCode;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "zero-team-")); config = join(directory, "team.json"); priorExitCode = process.exitCode; process.exitCode = undefined; });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); process.exitCode = priorExitCode; });
function command(password = "private test password") {
  const program = new Command().exitOverride(); const out = vi.fn(); const error = vi.fn(); const readPassword = vi.fn(async () => password);
  registerTeamCommand(program, { out, error, readPassword });
  return { run: (...args: string[]) => program.parseAsync(["node", "0", "team", ...args]), out, error, readPassword };
}
async function initialize() {
  const cli = command(); await cli.run("init", "--config", config, "--name", "Security", "--owner", "alex", "--display-name", "Alex"); return cli;
}
describe("team account provisioning", () => {
  it("creates a private configuration with a usable hash and no credentials in output", async () => {
    const cli = await initialize(); const data = JSON.parse(readFileSync(config, "utf8")) as TeamConfig;
    expect(statSync(config).mode & 0o777).toBe(0o600); expect(data.workspace.id).toMatch(/^[\da-f-]{36}$/);
    expect(data.users[0]).toMatchObject({ id: "alex", name: "Alex", role: "owner" });
    expect(data.users[0]!.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(cli.out.mock.calls)).not.toContain("private test password");
    expect(JSON.stringify(cli.out.mock.calls)).not.toContain("scrypt$");
    const auth = new TeamAuth({ configPath: config, origin: "http://127.0.0.1:48123" });
    expect((await auth.login({ userId: "alex", password: "private test password" })).user.role).toBe("owner");
  });
  it("does not overwrite or prompt when initialization targets an existing file", async () => {
    await initialize(); const original = readFileSync(config, "utf8"); const cli = command("other secret");
    await cli.run("init", "--config", config, "--name", "Changed", "--owner", "other", "--display-name", "Other");
    expect(process.exitCode).toBe(1); expect(readFileSync(config, "utf8")).toBe(original); expect(cli.readPassword).not.toHaveBeenCalled();
  });
  it("adds a role explicitly, lists without hashes, and rejects duplicate accounts", async () => {
    await initialize(); const add = command("viewer test secret");
    await add.run("add-user", "--config", config, "--user", "morgan", "--display-name", "Morgan", "--role", "viewer");
    expect(statSync(config).mode & 0o777).toBe(0o600);
    const auth = new TeamAuth({ configPath: config, origin: "http://127.0.0.1:48123" });
    expect((await auth.login({ userId: "morgan", password: "viewer test secret" })).user.role).toBe("viewer");
    const list = command(); await list.run("list", "--config", config);
    expect(JSON.parse(list.out.mock.calls[0]![0]).users).toEqual([{ id: "alex", name: "Alex", role: "owner" }, { id: "morgan", name: "Morgan", role: "viewer" }]);
    expect(JSON.stringify(list.out.mock.calls)).not.toContain("scrypt$"); expect(list.readPassword).not.toHaveBeenCalled();
    const original = readFileSync(config, "utf8"); const duplicate = command();
    await duplicate.run("add-user", "--config", config, "--user", "morgan", "--display-name", "Another", "--role", "owner");
    expect(readFileSync(config, "utf8")).toBe(original); expect(duplicate.readPassword).not.toHaveBeenCalled(); expect(duplicate.error).toHaveBeenCalled();
  });
  it("rejects invalid roles and insecure existing configuration permissions", async () => {
    await initialize(); const invalid = command();
    await invalid.run("add-user", "--config", config, "--user", "morgan", "--display-name", "Morgan", "--role", "administrator");
    expect(invalid.readPassword).not.toHaveBeenCalled(); expect(invalid.error).toHaveBeenCalledWith("Team setup failed: Invalid team configuration or account fields");
    chmodSync(config, 0o644); const insecure = command();
    await insecure.run("add-user", "--config", config, "--user", "morgan", "--display-name", "Morgan", "--role", "editor");
    expect(insecure.readPassword).not.toHaveBeenCalled(); expect(insecure.error.mock.calls[0]![0]).toContain("chmod 600");
  });
});
