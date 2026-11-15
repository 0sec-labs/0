import { join } from "node:path";
import type { Command } from "commander";
import { homeStateDir } from "@0/engine/shared";
import { FindingsAccessTokenStore } from "../web/findings-access-tokens.js";
import { createBackendHandshake } from "../web/backend-connections.js";
import { findTeamConfigPath } from "../web/team-setup.js";
import { finishWithError, renderTable, UsageError } from "./output.js";

export interface FindingsKeysDeps {
  out(text: string): void;
  err(text: string): void;
  /** Resolves the credential store for this workspace; injected in tests. */
  store(options: { dbPath?: string }): FindingsAccessTokenStore;
}
const defaults: FindingsKeysDeps = {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  store: ({ dbPath }) => {
    // Team workspaces keep per-workspace credentials behind the owner role; manage those in the web UI.
    if (findTeamConfigPath({ workspacePath: process.cwd(), explicitConfigPath: process.env.ZERO_TEAM_CONFIG })) {
      throw new UsageError("This workspace uses team sign-in; manage API access keys as the workspace owner in the web UI.");
    }
    return new FindingsAccessTokenStore({ workspaceId: createBackendHandshake(dbPath).engineId, stateDir: join(homeStateDir(), "findings-api-access") });
  },
};
interface KeyOptions { dbPath?: string; json?: boolean; name?: string; expiresIn?: string; yes?: boolean }

export function registerFindingsKeysCommand(parent: Command, deps: FindingsKeysDeps = defaults): void {
  const keys = parent.command("keys").description("Manage read-only API access keys for the findings API");
  const run = (command: Command, handler: (store: FindingsAccessTokenStore, options: KeyOptions, args: string[]) => void, validate: (options: KeyOptions, args: string[]) => void = () => {}) =>
    command.option("--db-path <path>", "Path to SQLite database").option("--json", "Print JSON")
      .action((...received: unknown[]) => {
        const options = received[received.length - 2] as KeyOptions;
        const args = received.slice(0, -2).filter((value): value is string => typeof value === "string");
        try { validate(options, args); handler(deps.store(options), options, args); }
        catch (error) { finishWithError(error, deps, options.json); }
      });

  run(keys.command("list").description("List API access keys (secrets are never shown)"), (store, options) => {
    const credentials = store.list();
    deps.out(options.json ? JSON.stringify({ credentials }, null, 2) : credentials.length ? renderTable(credentials, [
      { header: "ID", value: row => row.id, max: 36 }, { header: "NAME", value: row => row.name },
      { header: "EXPIRES", value: row => row.expiresAt ?? "never" }, { header: "STATUS", value: row => row.revokedAt ? "revoked" : "active" },
    ]) : "No API access keys.");
  });

  run(keys.command("create <name>").description("Create a read-only API access key; the secret is printed once")
    .option("--expires-in <days>", "Days until the key expires (default 90)"), (store, options, [name]) => {
    const days = options.expiresIn === undefined ? undefined : Number(options.expiresIn);
    const created = store.create({ name, ...(days === undefined ? {} : { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }) }, "local-owner");
    deps.out(options.json ? JSON.stringify(created, null, 2) : `${created.token}\n`);
    if (!options.json) deps.err(`Created key ${created.credential.id} (${created.credential.name}). Store the secret now; it cannot be shown again.`);
  }, (options, [name]) => {
    if (!name?.trim()) throw new UsageError("Supply a key name.");
    if (options.expiresIn !== undefined && (!Number.isFinite(Number(options.expiresIn)) || Number(options.expiresIn) <= 0)) throw new UsageError("--expires-in must be a positive number of days.");
  });

  run(keys.command("revoke <id>").description("Revoke an API access key").option("--yes", "Confirm the revocation"), (store, options, [id]) => {
    const credential = store.revoke(id!);
    deps.out(options.json ? JSON.stringify({ credential }, null, 2) : `Revoked ${credential.id} (${credential.name})`);
  }, (options, [id]) => {
    if (!/^[a-f0-9-]{36}$/.test(id ?? "")) throw new UsageError("Key ID must be a UUID from `0 findings keys list`.");
    if (!options.yes) throw new UsageError("Revoking a key is irreversible. Re-run with --yes to confirm.");
  });
}
