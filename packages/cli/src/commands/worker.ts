import type { Command } from "commander";
import { enginesConfigOption } from "./shared-options.js";
import { deployWorker, repairWorker, stopWorker, validateWorkerOptions } from "../worker-deploy.js";
import { discoverSshHosts } from "../worker-hosts.js";

export function registerWorkerCommand(program: Command): void {
  const worker = program
    .command("worker")
    .description("Deploy and manage remote engines");

  const deploy = worker
    .command("deploy")
    .description("Deploy a 0 engine onto a remote Linux server (Lima VM or any SSH host) and register it as an engine")
    .option("--ssh <user@host>", "SSH target host (BatchMode; key auth from ssh config/agent)")
    .option("--lima <name>", "Lima instance name", "zero-worker")
    .option("--target-git <url>", "Repository the remote server clones into the engine workspace instead of the bundled demo target")
    .option("--ssh-config <path>", "OpenSSH config file for the SSH target (e.g. a Lima instance's ssh.config)")
    .option("--engine-port <port>", "Engine port on the remote server (default: stable port derived from host)")
    .option("--forward-provider-key", "Forward this machine's OPENAI_API_KEY to the remote engine (user-owned hosts only)", false)
    .action(async (opts: { ssh?: string; lima: string; targetGit?: string; enginePort?: string; forwardProviderKey: boolean; sshConfig?: string; enginesConfig?: string }) => {
      const port = opts.enginePort === undefined ? undefined : Number.parseInt(opts.enginePort, 10);
      if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error("--engine-port must be 1-65535");
      validateWorkerOptions({ ...(opts.ssh ? { ssh: opts.ssh, ...(opts.sshConfig ? { sshConfig: opts.sshConfig } : {}) } : { lima: opts.lima }), ...(opts.targetGit ? { targetGit: opts.targetGit } : {}) });
      const result = await deployWorker({
        ...(opts.ssh ? { ssh: opts.ssh } : { lima: opts.lima }),
        ...(opts.sshConfig ? { sshConfig: opts.sshConfig } : {}),
        ...(opts.targetGit ? { targetGit: opts.targetGit } : {}),
        ...(opts.enginesConfig ? { enginesConfig: opts.enginesConfig } : {}),
        ...(port === undefined ? {} : { enginePort: port }),
        forwardProviderKey: opts.forwardProviderKey,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });
  enginesConfigOption(deploy, "Engine registry path");

  worker
    .command("repair <backend-id>")
    .description("Reconnect a managed remote engine tunnel and start its retained engine when needed")
    .action(async (backendId: string) => {
      process.stdout.write(JSON.stringify(await repairWorker(backendId)) + "\n");
    });

  worker
    .command("stop <backend-id>")
    .description("Stop a managed remote engine and its owned tunnel; retain remote files and registration")
    .action(async (backendId: string) => {
      process.stdout.write(JSON.stringify(await stopWorker(backendId)) + "\n");
    });

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
        deploy: `0 worker deploy --ssh ${entry.alias}`,
      })), null, 2) + "\n");
    });
}
