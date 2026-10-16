import type { Command } from "commander";
import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { z } from "zod";
import { hashTeamPassword, type TeamConfig } from "../web/team-auth.js";

const memberSchema = z.object({ id: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160), role: z.enum(["owner", "editor", "viewer"]), passwordHash: z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/).optional(), oidcSub: z.string().min(1).optional() }).strict();
const configSchema = z.object({ workspace: z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(160) }).strict(), users: z.array(memberSchema).min(1).max(1000), oidc: z.object({ issuer: z.string().url(), clientId: z.string().min(1), clientSecretEnv: z.string().min(1).optional(), redirectUri: z.string().url() }).strict().optional() }).strict();
export interface TeamCommandDependencies { readPassword?: () => Promise<string>; out?: (line: string) => void; error?: (line: string) => void }
function readPrivateConfig(path: string): TeamConfig {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Team configuration must be a private regular file (chmod 600)");
    if (stat.size > 1024 * 1024) throw new Error("Team configuration is too large");
    const cfg = configSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    if (new Set(cfg.users.map(user => user.id)).size !== cfg.users.length) throw new Error("Team user IDs must be unique");
    return cfg;
  } finally { closeSync(fd); }
}
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let password = "";
    for await (const chunk of process.stdin) { password += chunk.toString(); if (password.length > 1026) throw new Error("Password is too long"); }
    return password.replace(/\r?\n$/, "");
  }
  process.stderr.write("Password: "); emitKeypressEvents(process.stdin);
  const priorRaw = process.stdin.isRaw; const priorPaused = process.stdin.isPaused();
  process.stdin.setRawMode(true); process.stdin.resume();
  try {
    return await new Promise<string>((resolvePassword, reject) => {
      let password = "";
      const done = (error?: Error) => { process.stdin.removeListener("keypress", onKey); process.stderr.write("\n"); if (error) reject(error); else resolvePassword(password); };
      const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === "c") return done(new Error("Password entry cancelled"));
        if (key.name === "return" || key.name === "enter") return done();
        if (key.name === "backspace") { password = Array.from(password).slice(0, -1).join(""); return; }
        if (key.ctrl || !text || /[\x00-\x1f\x7f]/.test(text)) return;
        password += text; if (password.length > 1024) done(new Error("Password is too long"));
      };
      process.stdin.on("keypress", onKey);
    });
  } finally { process.stdin.setRawMode(priorRaw ?? false); if (priorPaused) process.stdin.pause(); }
}
function writeNew(path: string, config: TeamConfig): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, "utf8"); }
  catch (error) { try { unlinkSync(path); } catch { /* Preserve original failure. */ } throw error; }
  finally { closeSync(fd); }
}
export function registerTeamCommand(program: Command, dependencies: TeamCommandDependencies = {}): void {
  const out = dependencies.out ?? console.log; const error = dependencies.error ?? console.error;
  const password = dependencies.readPassword ?? readPassword;
  const team = program.command("team").description("Provision opt-in local team workspace accounts");
  const perform = (action: () => Promise<void> | void) => async () => {
    try { await action(); } catch (failure) {
      // Never format parsed config, Zod values or credentials into a terminal error.
      const safe = failure instanceof z.ZodError ? "Invalid team configuration or account fields" : failure instanceof Error ? failure.message : "Operation failed";
      error(`Team setup failed: ${safe}`); process.exitCode = 1;
    }
  };
  const init = team.command("init").description("Create a private team configuration; does not enable it on a running engine")
    .requiredOption("--config <path>", "Configuration file to create")
    .requiredOption("--name <name>", "Workspace name")
    .requiredOption("--owner <id>", "Owner account ID")
    .requiredOption("--display-name <name>", "Owner display name");
  init.action(perform(async () => {
    const opts = init.opts<{ config: string; name: string; owner: string; displayName: string }>();
    const member = memberSchema.parse({ id: opts.owner, name: opts.displayName, role: "owner" });
    const workspace = configSchema.shape.workspace.parse({ id: randomUUID(), name: opts.name });
    // Reserve before requesting a credential, so an existing config never prompts or changes.
    const path = resolve(opts.config); const fd = openSync(path, "wx", 0o600);
    try {
      member.passwordHash = await hashTeamPassword(await password());
      writeFileSync(fd, `${JSON.stringify({ workspace, users: [member] }, null, 2)}\n`, "utf8");
    } catch (failure) { try { unlinkSync(path); } catch { /* Original error wins. */ } throw failure; }
    finally { closeSync(fd); }
    out(`Created team configuration: ${path}`);
  }));
  const add = team.command("add-user").description("Add a password account to an existing private configuration")
    .requiredOption("--config <path>", "Team configuration")
    .requiredOption("--user <id>", "Account ID")
    .requiredOption("--display-name <name>", "Display name")
    .requiredOption("--role <role>", "owner, editor or viewer");
  add.action(perform(async () => {
    const opts = add.opts<{ config: string; user: string; displayName: string; role: string }>();
    const member = memberSchema.parse({ id: opts.user, name: opts.displayName, role: opts.role });
    const path = resolve(opts.config); const lock = `${path}.lock`; const lockFD = openSync(lock, "wx", 0o600);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const config = readPrivateConfig(path);
      if (config.users.some(user => user.id === member.id)) throw new Error("That account ID already exists");
      if (config.users.length >= 1000) throw new Error("Workspace member limit reached");
      member.passwordHash = await hashTeamPassword(await password());
      config.users.push(member); writeNew(temporary, config); renameSync(temporary, path);
      out(`Added account: ${member.id}`);
    } finally { closeSync(lockFD); unlinkSync(lock); try { unlinkSync(temporary); } catch { /* Normally renamed or never created. */ } }
  }));
  const list = team.command("list").description("List workspace accounts without credentials")
    .requiredOption("--config <path>", "Team configuration");
  list.action(perform(() => {
    const config = readPrivateConfig(resolve(list.opts<{ config: string }>().config));
    out(JSON.stringify({ workspace: config.workspace, users: config.users.map(({ id, name, role }) => ({ id, name, role })) }, null, 2));
  }));
}
