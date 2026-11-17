import type { Command } from "commander";
import { enginesConfigOption } from "./shared-options.js";
import { deployWorker, repairWorker, stopWorker, validateWorkerOptions } from "../worker-deploy.js";
import { discoverSshHosts } from "../worker-hosts.js";
import { BackendConnectionRegistry, loadBackendConnectionConfig } from "../web/backend-connections.js";
import { loadManagedWorker } from "../worker-deploy.js";
import { printJson, renderTable, sinks, type ConsoleCommandDeps, type JsonOption } from "./console-support.js";

/** Registered computers (the web Computers page): id, name, host and whether 0 deployed and can reconnect it. */
export function runComputersList(options: JsonOption & { enginesConfig?: string }, deps: ConsoleCommandDeps = {}): void {
  const io = sinks(deps);
  try {
    const rows = loadBackendConnectionConfig(options.enginesConfig).map(row => {
      let host = "";
      try { host = new URL(row.url).host; } catch { host = "invalid URL"; }
      let managed = true;
      try { loadManagedWorker(row.id); } catch { managed = false; }
      return { id: row.id, name: row.name, host, managed };
    });
    if (options.json) printJson(io, { computers: rows });
    else io.out(rows.length ? renderTable(["ID", "NAME", "HOST", "MANAGED"], rows.map(r => [r.id, r.name, r.host, r.managed ? "yes" : "no"])) : "No remote computers. Add one with `0 computers add --ssh user@host`.");
    io.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the computer registry.";
    io.err(options.json ? JSON.stringify({ error: message }) : `error: ${message}`);
    io.exit(1);
  }
}

export function registerWorkerCommand(program: Command): void {
  const worker = program
    .command("computers")
    .alias("worker")
    .description("Add and manage remote computers");

  const list = worker
    .command("list")
    .description("List registered remote computers")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean; enginesConfig?: string }) => runComputersList(opts));
  enginesConfigOption(list, "Engine registry path");

  const deploy = worker
    .command("add")
    .alias("deploy")
    .description("Add a remote computer: deploy 0 onto a Linux server (Lima VM or any SSH host) and register it")
    .option("--ssh <user@host>", "SSH target host (BatchMode; key auth from ssh config/agent)")
    .option("--lima <name>", "Lima instance name", "zero-worker")
    .option("--target-git <url>", "Repository the remote server clones into the engine folder instead of the bundled demo target")
    .option("--ssh-config <path>", "OpenSSH config file for the SSH target (e.g. a Lima instance's ssh.config)")
    .option("--engine-port <port>", "Engine port on the remote server (default: stable port derived from host)")
    .option("--trust-new-host", "Trust and remember the computer's SSH host key if it is not known yet", false)
    .option("--forward-provider-key", "Forward this computer's OPENAI_API_KEY to the remote engine (user-owned hosts only)", false)
    .action(async (opts: { ssh?: string; lima: string; targetGit?: string; enginePort?: string; forwardProviderKey: boolean; trustNewHost: boolean; sshConfig?: string; enginesConfig?: string }) => {
      const port = opts.enginePort === undefined ? undefined : Number.parseInt(opts.enginePort, 10);
      if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error("--engine-port must be 1-65535");
      validateWorkerOptions({ ...(opts.ssh ? { ssh: opts.ssh, ...(opts.sshConfig ? { sshConfig: opts.sshConfig } : {}) } : { lima: opts.lima }), ...(opts.targetGit ? { targetGit: opts.targetGit } : {}) });
      const result = await deployWorker({
        ...(opts.ssh ? { ssh: opts.ssh } : { lima: opts.lima }),
        ...(opts.sshConfig ? { sshConfig: opts.sshConfig } : {}),
        ...(opts.targetGit ? { targetGit: opts.targetGit } : {}),
        ...(opts.enginesConfig ? { enginesConfig: opts.enginesConfig } : {}),
        ...(port === undefined ? {} : { enginePort: port }),
        ...(opts.trustNewHost ? { trustNewHost: true } : {}),
        forwardProviderKey: opts.forwardProviderKey,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });
  enginesConfigOption(deploy, "Engine registry path");

  worker
    .command("repair <backend-id>")
    .alias("reconnect")
    .description("Reconnect a managed remote computer's tunnel and start its retained engine when needed")
    .action(async (backendId: string) => {
      process.stdout.write(JSON.stringify(await repairWorker(backendId)) + "\n");
    });

  worker
    .command("stop <backend-id>")
    .description("Stop a managed remote computer and its owned tunnel; retain remote files and registration")
    .action(async (backendId: string) => {
      process.stdout.write(JSON.stringify(await stopWorker(backendId)) + "\n");
    });

  const remove = worker
    .command("remove <backend-id>")
    .description("Remove a remote computer from this machine: closes the tunnel and forgets its saved connection (files on the remote computer stay)")
    .action((backendId: string, opts: { enginesConfig?: string }) => {
      try {
        new BackendConnectionRegistry(opts.enginesConfig ? { configPath: opts.enginesConfig } : {}).remove(backendId);
      } catch (error) {
        throw new Error(error instanceof Error && /not registered/.test(error.message) ? `No computer with ID ${backendId}. Run \`0 computers list\` to see the IDs.` : error instanceof Error ? error.message : "Could not remove the computer.");
      }
      process.stdout.write(JSON.stringify({ removed: true, backendId, remoteFilesRemoved: false }) + "\n");
    });
  enginesConfigOption(remove, "Engine registry path");

  worker
    .command("hosts")
    .description("List SSH hosts discovered from ~/.ssh/config as deploy candidates")
    .action(() => {
      const hosts = discoverSshHosts();
      process.stdout.write(JSON.stringify(hosts.map(entry => ({
        alias: entry.alias,
        ...(entry.hostname ? { hostname: entry.hostname } : {}),
        ...(entry.user ? { user: entry.user } : {}),
        ...(entry.port ? { port: entry.port } : {}),
        deploy: `0 computers add --ssh ${entry.alias}`,
      })), null, 2) + "\n");
    });
}
