import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { homeStateDir } from "@0/shared";
import { ANALYTICS_LEVEL_ENV, getSmolvmWorkbenchStatus, isAdmittedSmolvmWorkbench, levelAtLeast, resolveAnalyticsLevel, createConsoleRuntime, createWorkbenchProviderBroker } from "@0/core";
import type { SmolvmWorkbenchApprovedImage, SmolvmWorkbenchResult } from "@0/core";
import { currentWorkbenchAssets } from "./workbench-assets.js";
import { mapWorkbenchCliArguments } from "./workbench-console-protocol.js";
import { runWorkbenchCli } from "./workbench-console-session.js";
import { remoteBackendClientId } from "./backend-client-mode.js";
import { PROVIDERS } from "./tui/provider-status.js";
import { loadGlobalSettings, normalizeSettings, saveSettings } from "./tui/settings.js";
import type { TuiSettings } from "./tui/settings.js";
import { FEEDBACK_OPT_OUT_ENV, submissionBlockedReason } from "./tui/feedback.js";

export const WORKBENCH_INNER_ARGUMENT = "--workbench-inner";

/** Only operator choices belong here; credentials are resolved for one launch. */
export interface WorkbenchConfig {
  schemaVersion: 1;
  image: string;
  imageDigest: string;
  stateRoot: string;
  /** Unset means the directory from which the operator invokes 0. */
  workspaceRoot?: string;
  providers: string[];
  github: boolean;
  cpus: number;
  memoryMb: number;
  storageGb: number;
  /** Host-only image-reference grants for brokered isolated container actions. */
  approvedImages?: SmolvmWorkbenchApprovedImage[];
}

export function workbenchConfigPath(home: string = process.env.HOME || homedir()): string {
  return join(homeStateDir(home), "workbench.json");
}

export function defaultWorkbenchStateRoot(home: string = process.env.HOME || homedir()): string {
  return join(homeStateDir(home), "workbench");
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

export function isPinnedWorkbenchImageReference(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value)
    && !value.slice(0, value.indexOf("@")).slice(value.lastIndexOf("/") + 1).includes(":");
}

export function normalizeWorkbenchConfig(raw: unknown): WorkbenchConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid workbench operator choices.");
  const config = raw as Record<string, unknown>;
  if (config.github === true) throw new Error("GitHub credential forwarding is not supported by the isolated workbench. Revoke the GitHub grant before launch.");
  if (Array.isArray(config.providers) && config.providers.some(provider => provider !== "chatgpt-codex")) throw new Error("The isolated workbench currently supports only host-brokered chatgpt-codex grants.");
  const approvedImages: SmolvmWorkbenchApprovedImage[] = [];
  if (config.approvedImages !== undefined) {
    if (!Array.isArray(config.approvedImages)) throw new Error("Invalid workbench sandbox image catalog.");
    const references = new Set<string>();
    for (const rawImage of config.approvedImages) {
      if (typeof rawImage !== "object" || rawImage === null || Array.isArray(rawImage)) throw new Error("Invalid workbench sandbox image catalog.");
      const image = rawImage as Record<string, unknown>;
      if (!isPinnedWorkbenchImageReference(image.reference)
        || typeof image.archive !== "string" || !isAbsolute(image.archive)
        || typeof image.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image.digest)
        || references.has(image.reference)) throw new Error("Sandbox image grants require unique immutable repository@sha256 references and approved local archives.");
      references.add(image.reference);
      approvedImages.push({ reference: image.reference, archive: image.archive, digest: image.digest });
    }
  }
  if (config.schemaVersion !== 1 || typeof config.image !== "string" || !isAbsolute(config.image)
    || typeof config.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(config.imageDigest)
    || typeof config.stateRoot !== "string" || !isAbsolute(config.stateRoot)
    || (config.workspaceRoot !== undefined && (typeof config.workspaceRoot !== "string" || !isAbsolute(config.workspaceRoot)))
    || !Array.isArray(config.providers) || config.providers.some((id) => typeof id !== "string" || !PROVIDERS.some((provider) => provider.id === id))
    || typeof config.github !== "boolean" || !positiveInteger(config.cpus, 64)
    || !positiveInteger(config.memoryMb, 262144) || !positiveInteger(config.storageGb, 1024)) {
    throw new Error("Invalid workbench operator choices.");
  }
  return {
    schemaVersion: 1,
    image: config.image,
    imageDigest: config.imageDigest,
    stateRoot: config.stateRoot,
    ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot as string }),
    providers: [...new Set(config.providers as string[])],
    github: config.github,
    cpus: config.cpus,
    memoryMb: config.memoryMb,
    storageGb: config.storageGb,
    ...(approvedImages.length ? { approvedImages } : {}),
  };
}

export function loadWorkbenchConfig(home?: string): WorkbenchConfig | undefined {
  const file = workbenchConfigPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error("Workbench configuration must be an operator-owned, private regular file (mode 0600).");
    }
    return normalizeWorkbenchConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Workbench configuration must")) throw error;
    throw new Error(`Unreadable or invalid workbench configuration at ${file}. Repair the operator choices before setup or launch; no profile fallback is allowed.`);
  }
}

export function saveWorkbenchConfig(config: WorkbenchConfig, home?: string): void {
  const path = workbenchConfigPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalizeWorkbenchConfig(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}


export function resolveWorkbenchGuestSettings(settings: TuiSettings, env: Readonly<NodeJS.ProcessEnv> = process.env): TuiSettings {
  const privacy: NodeJS.ProcessEnv = { [ANALYTICS_LEVEL_ENV]: env[ANALYTICS_LEVEL_ENV] ?? settings.analyticsLevel };
  for (const name of FEEDBACK_OPT_OUT_ENV) privacy[name] = env[name];
  const environmentLevel = resolveAnalyticsLevel(privacy);
  return normalizeSettings({
    ...settings,
    executionProfile: "local",
    updatePolicy: "off",
    analyticsLevel: levelAtLeast(environmentLevel, settings.analyticsLevel) ? settings.analyticsLevel : environmentLevel,
    diagnosticReporting: submissionBlockedReason(privacy, { allowCloud: false }) === "opt-out" ? "off" : settings.diagnosticReporting,
  });
}

export function workbenchNetworkEnabled(env: Readonly<NodeJS.ProcessEnv> = process.env): boolean {
  return submissionBlockedReason({ ZERO_OFFLINE: env.ZERO_OFFLINE }, { allowCloud: false }) !== "opt-out";
}

/** Leave admitted guest processes and explicitly local invocations in this process. */
export async function launchConfiguredWorkbench(args: readonly string[]): Promise<number | undefined> {
  const home = process.env.HOME || homedir();
  if (args[0] === WORKBENCH_INNER_ARGUMENT) {
    if (process.platform !== "linux" || !isAdmittedSmolvmWorkbench()) {
      throw new Error("Missing authenticated SmolVM broker admission; refusing internal invocation.");
    }
    process.argv = [process.argv[0]!, process.argv[1]!, ...args.slice(1)];
    return undefined;
  }
  // Child agents may invoke 0 without the private outer argv marker.
  if (process.platform === "linux" && isAdmittedSmolvmWorkbench()) return undefined;
  // The host management surface is deliberately available even after a failed VM launch.
  if (["workbench", "config", "web", "dashboard", "console", "tui", "doctor", "help", "--help", "-h", "--version", "-v"].includes(args[0] ?? "") || args.length === 0) return undefined;
  if (remoteBackendClientId(args)) return undefined;
  const hostSettings = loadGlobalSettings(home, { requireExecutionProfile: existsSync(workbenchConfigPath(home)) });
  if (hostSettings.executionProfile !== "smolvm") return undefined;
  if (args[0] === "mcp-server") {
    throw new Error("MCP requires bidirectional stdio, which the SmolVM CLI bridge does not support. The selected SmolVM profile is unchanged; host fallback is refused. Use `0 workflow` commands in SmolVM. MCP currently requires explicitly selected host-local execution; only the operator should choose `0 workbench disable` if host execution is intended.");
  }
  const config = loadWorkbenchConfig(home);
  if (!config) throw new Error("SmolVM profile is selected but no workbench is configured. Run 0 workbench setup --image <approved-archive>.");
  const workspaceRoot = realpathSync(config.workspaceRoot ?? process.cwd());
  if (!lstatSync(workspaceRoot).isDirectory()) throw new Error("The configured workbench workspace is not a directory.");
  const status = await getSmolvmWorkbenchStatus({ stateRoot: config.stateRoot, image: config.image });
  if (!status.platformSupported || !status.runtimeReady || !status.imageApproved) {
    throw new Error(status.error ?? "SmolVM runtime or approved image is unavailable. Run 0 workbench setup; host fallback is refused.");
  }
  const modelIndex = args.findIndex(argument => argument === "--model" || argument === "-m");
  const modelArgument = modelIndex >= 0 ? args[modelIndex + 1] : args.find(argument => argument.startsWith("--model="))?.slice("--model=".length);
  const runtime = createConsoleRuntime({ model: modelArgument });
  const providerId = runtime.resolvedProvider();
  if (providerId !== "chatgpt-codex" || !config.providers.includes(providerId)) throw new Error("Isolated CLI execution requires an explicitly granted brokered chatgpt-codex provider. Host fallback is refused.");
  const model = runtime.resolvedModel();
  const routing = runtime.modelSelection();
  const broker = createWorkbenchProviderBroker({ provider: providerId,
    models: [...new Set([model, ...Object.values(routing.agentModels).filter(value => value !== "auto")])],
    resolveCredentials: runtime.workbenchCredentialResolver(),
  });
  const network = workbenchNetworkEnabled();
  const controller = new AbortController();
  let signalCode: number | undefined;
  const interrupt = () => { signalCode = 130; controller.abort(); };
  const terminate = () => { signalCode = 143; controller.abort(); };
  const hangup = () => { signalCode = 129; controller.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.once("SIGHUP", hangup);
  let result: SmolvmWorkbenchResult;
  try {
    result = await runWorkbenchCli({
      workbench: config, selection: { provider: providerId, model, ...routing }, provider: { ...broker.grant, request: broker.request, close: broker.close },
      assets: currentWorkbenchAssets(), guestSettings: resolveWorkbenchGuestSettings(hostSettings),
      network, args: mapWorkbenchCliArguments(args, workspaceRoot), signal: controller.signal,
      onStdout: (data) => process.stdout.write(data), onStderr: (data) => process.stderr.write(data),
    });
  } finally {
    await broker.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGHUP", hangup);
  }
  if (result.cleanupFailed) {
    process.stderr.write("[0] SmolVM cleanup could not be proven. Workbench admission/state is retained; host execution is refused.\n");
    return 125;
  }
  if (result.artifacts) process.stderr.write(`[0] Guest workspace and results saved at ${result.artifacts.directory}\n`);
  if (result.error) process.stderr.write(`[0] ${result.error}\n`);
  if (result.timedOut) return 124;
  return signalCode ?? result.exitCode ?? 125;
}

export function selectWorkbenchProfile(profile: "local" | "smolvm", home?: string): void {
  if (!saveSettings({ ...loadGlobalSettings(home), executionProfile: profile }, home)) throw new Error("Could not persist the operator execution profile.");
}

