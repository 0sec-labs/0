import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Option } from "commander";
import type { Command } from "commander";
import { DEFAULT_WORKBENCH_BROKER_LIMITS, approveSmolvmWorkbenchImage, getSmolvmWorkbenchStatus, resolveSmolvmRuntime } from "@0/core";
import type { SmolvmWorkbenchApprovedImage } from "@0/core";
import { DEFAULT_SETTINGS, loadGlobalSettings } from "../tui/settings.js";
import { PROVIDERS } from "../tui/provider-status.js";
import { defaultWorkbenchStateRoot, isPinnedWorkbenchImageReference, loadWorkbenchConfig, resolveWorkbenchGuestSettings, saveWorkbenchConfig, selectWorkbenchProfile, workbenchConfigPath, workbenchNetworkEnabled } from "../workbench.js";
import type { WorkbenchConfig } from "../workbench.js";

interface WorkbenchSetupOptions {
  image?: string;
  state?: string;
  workspace?: string;
  provider?: string[];
  github?: boolean;
  cpus?: string;
  memory?: string;
  storage?: string;
  sandboxImage?: string[];
}

function resource(value: string | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be between 1 and ${maximum}.`);
  return parsed;
}

export async function approveWorkbenchSandboxImages(selections: readonly string[], stateRoot: string, current: readonly SmolvmWorkbenchApprovedImage[] = []): Promise<SmolvmWorkbenchApprovedImage[]> {
  const archives = new Map<string, string>();
  for (const image of current) archives.set(image.reference, image.archive);
  const selected = new Set<string>();
  for (const selection of selections) {
    const separator = selection.indexOf("=");
    const reference = selection.slice(0, separator);
    const archive = selection.slice(separator + 1);
    if (separator < 1 || !archive || !isPinnedWorkbenchImageReference(reference) || selected.has(reference)) {
      throw new Error("Sandbox image approval requires a unique repository@sha256:<64hex>=<local-archive>; mutable tags and guest-selected paths are refused.");
    }
    selected.add(reference);
    archives.set(reference, resolve(archive));
  }
  const approvedImages: SmolvmWorkbenchApprovedImage[] = [];
  for (const [reference, imageArchive] of archives) {
    const approved = await approveSmolvmWorkbenchImage({ imageArchive, stateRoot });
    approvedImages.push({ reference, archive: approved.path, digest: approved.digest });
  }
  return approvedImages;
}

export async function setupWorkbench(options: WorkbenchSetupOptions, home: string = process.env.HOME || homedir()): Promise<WorkbenchConfig> {
  const previous = loadWorkbenchConfig(home);
  const stateRoot = resolve(options.state ?? previous?.stateRoot ?? defaultWorkbenchStateRoot(home));
  const workspaceRoot = options.workspace === undefined ? previous?.workspaceRoot : realpathSync(resolve(options.workspace));
  if (workspaceRoot !== undefined && !lstatSync(workspaceRoot).isDirectory()) throw new Error("Workbench workspace must be a directory.");
  const providers = options.provider ?? previous?.providers ?? [];
  for (const id of providers) if (!PROVIDERS.some((provider) => provider.id === id)) throw new Error(`Unknown provider grant: ${id}. Use 0 workbench providers.`);
  // Reuse only a saved operator-approved image, never an archive found in a checkout.
  const imageArchive = options.image ? resolve(options.image) : previous?.image;
  if (!imageArchive) throw new Error("No approved workbench image is available. Supply a locally provisioned archive with 0 workbench setup --image <archive>. Docker is only needed to build an image, never to run this profile.");
  const cpus = resource(options.cpus, previous?.cpus ?? 2, 64, "CPUs");
  const memoryMb = resource(options.memory, previous?.memoryMb ?? 4096, 262144, "Memory (MiB)");
  const storageGb = resource(options.storage, previous?.storageGb ?? 20, 1024, "Storage (GiB)");
  const status = await getSmolvmWorkbenchStatus({ stateRoot });
  if (status.retainedRuns.length) throw new Error("Unproven prior cleanup retains SmolVM admission. Resolve it before changing workbench configuration.");
  const approvedImages = await approveWorkbenchSandboxImages(options.sandboxImage ?? [], stateRoot, previous?.approvedImages);
  await resolveSmolvmRuntime({ stateRoot });
  const approved = await approveSmolvmWorkbenchImage({ imageArchive, stateRoot });
  const config: WorkbenchConfig = {
    schemaVersion: 1,
    image: approved.path,
    imageDigest: approved.digest,
    stateRoot,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    providers: [...new Set(providers)],
    github: options.github ?? previous?.github ?? false,
    cpus,
    memoryMb,
    storageGb,
    ...(approvedImages.length ? { approvedImages } : {}),
  };
  saveWorkbenchConfig(config, home);
  selectWorkbenchProfile("smolvm", home);
  return config;
}

export async function workbenchStatus(home: string = process.env.HOME || homedir()): Promise<Record<string, unknown>> {
  const config = loadWorkbenchConfig(home);
  const stateRoot = config?.stateRoot ?? defaultWorkbenchStateRoot(home);
  const status = await getSmolvmWorkbenchStatus({ stateRoot, ...(config ? { image: config.image } : {}) });
  const hostSettings = loadGlobalSettings(home, { requireExecutionProfile: !!config });
  const guestSettings = resolveWorkbenchGuestSettings(hostSettings);
  return {
    profile: hostSettings.executionProfile,
    configured: !!config,
    configuration: workbenchConfigPath(home),
    stateRoot,
    workspace: config?.workspaceRoot ?? "current invocation directory → /workspace",
    providers: config?.providers ?? [],
    github: config?.github ?? false,
    image: config?.image ?? null,
    imageDigest: config?.imageDigest ?? null,
    resources: config ? { cpus: config.cpus, memoryMb: config.memoryMb, storageGb: config.storageGb } : null,
    approvedImages: config?.approvedImages ?? [],
    networkEnabled: workbenchNetworkEnabled(),
    privacy: { analyticsLevel: guestSettings.analyticsLevel, diagnosticReporting: guestSettings.diagnosticReporting },
    brokerLimits: DEFAULT_WORKBENCH_BROKER_LIMITS,
    ...status,
  };
}

export function registerWorkbenchCommand(program: Command): void {
  const workbench = program.command("workbench").description("Set up and inspect the whole-harness online SmolVM workbench (no Docker runtime)");
  workbench.command("setup")
    .description("Verify/provision the signed native runtime, approve a local image, and select SmolVM execution")
    .option("--image <archive>", "Local OCI/Docker archive to digest-pin and approve; never a mutable registry tag")
    .option("--state <directory>", "Private VM state directory (defaults to ~/.0/workbench)")
    .option("--workspace <directory>", "Explicit workspace mount; otherwise each invocation mounts its current directory")
    .option("--provider <id>", "Grant this provider's selected account/environment credential; repeat for multiple providers", (id: string, ids: string[] = []) => [...ids, id])
    .option("--github", "Grant a GitHub token from GH_TOKEN/GITHUB_TOKEN or the existing gh account")
    .option("--no-github", "Revoke the GitHub token grant")
    .option("--cpus <count>", "Guest virtual CPUs")
    .option("--memory <MiB>", "Guest RAM in MiB")
    .option("--storage <GiB>", "Guest private writable storage in GiB")
    .option("--sandbox-image <reference=archive>", "Approve an immutable image reference for brokered isolated container actions; repeat for multiple images", (selection: string, selections: string[] = []) => [...selections, selection])
    .action(async (options: WorkbenchSetupOptions) => {
      try {
        const config = await setupWorkbench(options);
        console.log(`SmolVM workbench selected. Approved image: ${config.imageDigest}`);
        console.log(`Workspace: ${config.workspaceRoot ?? "each invocation's current directory"} → /workspace`);
        console.log(`Provider grants: ${config.providers.join(", ") || "none (connect inside the guest)"}; GitHub: ${config.github ? "granted" : "not granted"}`);
        console.log(`Sandbox image grants: ${config.approvedImages?.map((image) => image.reference).join(", ") || "none (no additional image references are granted)"}`);
        console.log(`Network: ${workbenchNetworkEnabled() ? "online" : "offline (explicit ZERO_OFFLINE restriction)"}`);
        console.log(`Isolated sandbox hard ceilings: ${JSON.stringify(DEFAULT_WORKBENCH_BROKER_LIMITS)}`);
        console.log("Run 0 or 0 console. All agents, tools and the browser execute inside this workbench VM.");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
  workbench.command("status").description("Inspect configuration, provisioned runtime, image approval and retained admission; never downloads")
    .option("--json", "Print machine-readable status (no credential values)")
    .action(async (options: { json?: boolean }) => {
      try {
        const status = await workbenchStatus();
        if (options.json) console.log(JSON.stringify(status, null, 2));
        else for (const [key, value] of Object.entries(status)) console.log(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
  workbench.command("providers").description("List explicit provider grant IDs; credentials are never displayed")
    .action(() => { for (const provider of PROVIDERS) console.log(`${provider.id.padEnd(16)} ${provider.label}`); });
  workbench.command("configure")
    .description("Change saved integration grants or return workspace selection to the invocation directory")
    .addOption(new Option("--provider <ids>", "Replace provider grants with comma-separated IDs, or none"))
    .option("--github", "Enable the explicit GitHub credential grant")
    .option("--no-github", "Revoke the GitHub credential grant")
    .option("--current-workspace", "Mount each invocation's current directory instead of a fixed saved workspace")
    .option("--sandbox-image <reference=archive>", "Add or replace an operator-approved immutable sandbox image reference; repeat for multiple images", (selection: string, selections: string[] = []) => [...selections, selection])
    .option("--clear-sandbox-images", "Revoke all explicit sandbox image-reference grants")
    .action(async (options: { provider?: string; github?: boolean; currentWorkspace?: boolean; sandboxImage?: string[]; clearSandboxImages?: boolean }) => {
      try {
        const config = loadWorkbenchConfig();
        if (!config) throw new Error("No workbench is configured. Run 0 workbench setup first.");
        if (options.provider !== undefined) config.providers = options.provider === "none" ? [] : options.provider.split(",").map((id) => id.trim());
        if (options.github !== undefined) config.github = options.github;
        if (options.currentWorkspace) delete config.workspaceRoot;
        if (options.clearSandboxImages) delete config.approvedImages;
        if (options.sandboxImage) {
          config.approvedImages = await approveWorkbenchSandboxImages(options.sandboxImage, config.stateRoot, config.approvedImages);
        }
        saveWorkbenchConfig(config);
        console.log("Workbench operator choices saved; they apply on the next launch.");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
  workbench.command("disable").description("Explicitly select host-local execution; retain the approved VM image and guest state")
    .action(() => {
      try {
        selectWorkbenchProfile(DEFAULT_SETTINGS.executionProfile);
        console.log("Host-local execution selected explicitly. Workbench guest state and approval are retained.");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
}
