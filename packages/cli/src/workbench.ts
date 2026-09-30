import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homeStateDir } from "@0/shared";
import { ANALYTICS_LEVEL_ENV, getSmolvmWorkbenchStatus, isAdmittedSmolvmWorkbench, levelAtLeast, resolveAnalyticsLevel, runSmolvmWorkbench } from "@0/core";
import type { SmolvmWorkbenchApprovedImage, SmolvmWorkbenchResult } from "@0/core";
import { maybeLoadCodexAuth } from "./codex-auth.js";
import { accountEnvPatch, loadAccountStore } from "./tui/credential-store.js";
import type { AccountStore } from "./tui/credential-store.js";
import { PROVIDERS } from "./tui/provider-status.js";
import { loadGlobalSettings, normalizeSettings, saveSettings } from "./tui/settings.js";
import type { TuiSettings } from "./tui/settings.js";
import { FEEDBACK_OPT_OUT_ENV, submissionBlockedReason } from "./tui/feedback.js";

const execFileAsync = promisify(execFile);
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


const PROVIDER_CONFIGURATION: Readonly<Record<string, readonly string[]>> = {
  "chatgpt-codex": ["ZERO_CHATGPT_ACCOUNT_ID", "ZERO_CHATGPT_BASE_URL"],
  deepseek: ["DEEPSEEK_BASE_URL"],
  openrouter: ["OPENROUTER_BASE_URL"],
  azure: ["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT", "OPENAI_BASE_URL"],
  openai: ["OPENAI_BASE_URL"],
  "z-ai": ["Z_AI_BASE_URL"],
  kimi: ["KIMI_BASE_URL"],
  qwen: ["QWEN_BASE_URL"],
  xai: ["XAI_BASE_URL"],
  opencode: ["OPENCODE_BASE_URL"],
  copilot: ["COPILOT_BASE_URL"],
  google: ["GOOGLE_CLOUD_PROJECT", "ZERO_GEMINI_PROJECT"],
  anthropic: ["ANTHROPIC_BASE_URL"],
};

/** The selected integration grant is an allowlist, not a host-env copy. */
export function selectedWorkbenchEnvironment(config: Pick<WorkbenchConfig, "providers" | "github">, env: Readonly<NodeJS.ProcessEnv>, accounts: AccountStore): Record<string, string> {
  const selected: AccountStore = { version: 2, providers: {} };
  const result: Record<string, string> = {};
  for (const id of config.providers) {
    const provider = PROVIDERS.find((candidate) => candidate.id === id);
    if (!provider) throw new Error(`Unknown workbench provider grant: ${id}`);
    const account = accounts.providers[id];
    if (account) selected.providers[id] = account;
    for (const name of [...provider.envVars, ...(PROVIDER_CONFIGURATION[id] ?? [])]) {
      const value = env[name];
      if (value?.trim()) result[name] = value;
    }
  }
  Object.assign(result, accountEnvPatch(selected, result));
  if (config.github) {
    const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
    if (token) result.GH_TOKEN = token;
  }
  for (const name of ["TERM", "COLORTERM", "NO_COLOR", "LANG", "LC_ALL"]) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

async function integrationEnvironment(config: WorkbenchConfig, home: string): Promise<Record<string, string>> {
  // Do not even open the credential store until an operator selects a provider.
  const accounts: AccountStore = config.providers.length ? loadAccountStore(home) : { version: 2, providers: {} };
  const environment = selectedWorkbenchEnvironment(config, process.env, accounts);
  if (config.providers.includes("chatgpt-codex")) {
    const codexEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      ZERO_CHATGPT_AUTH_FILE: process.env.ZERO_CHATGPT_AUTH_FILE,
      ZERO_CODEX_AUTH_JSON_PATH: process.env.ZERO_CODEX_AUTH_JSON_PATH,
    };
    maybeLoadCodexAuth({ env: codexEnvironment, home });
    for (const name of ["ZERO_CHATGPT_ACCESS_TOKEN", "ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]) {
      const value = codexEnvironment[name];
      if (value) environment[name] = value;
    }
  }
  if (config.github && !environment.GH_TOKEN) {
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
      if (stdout.trim()) environment.GH_TOKEN = stdout.trim();
    } catch {
      throw new Error("GitHub grant is enabled but no token is available. Connect gh on the host or run 0 workbench setup --no-github.");
    }
  }
  return environment;
}

/** Preserve the existing permission gates without forwarding endpoint authority. */
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
  if (args[0] === "workbench" || args[0] === "config") return undefined;
  const hostSettings = loadGlobalSettings(home, { requireExecutionProfile: existsSync(workbenchConfigPath(home)) });
  if (hostSettings.executionProfile !== "smolvm") return undefined;
  const config = loadWorkbenchConfig(home);
  if (!config) throw new Error("SmolVM profile is selected but no workbench is configured. Run 0 workbench setup --image <approved-archive>.");
  const workspaceRoot = realpathSync(config.workspaceRoot ?? process.cwd());
  if (!lstatSync(workspaceRoot).isDirectory()) throw new Error("The configured workbench workspace is not a directory.");
  const status = await getSmolvmWorkbenchStatus({ stateRoot: config.stateRoot, image: config.image });
  if (!status.platformSupported || !status.runtimeReady || !status.imageApproved) {
    throw new Error(status.error ?? "SmolVM runtime or approved image is unavailable. Run 0 workbench setup; host fallback is refused.");
  }
  const environment = await integrationEnvironment(config, home);
  const network = workbenchNetworkEnabled();
  if (!network) environment.ZERO_OFFLINE = "1";
  const guestState = join(config.stateRoot, "guest-state");
  mkdirSync(guestState, { recursive: true, mode: 0o700 });
  if (!lstatSync(guestState).isDirectory() || lstatSync(guestState).isSymbolicLink()) throw new Error("Workbench guest-state must be a real private directory.");
  const settingsFile = join(guestState, "tui-settings.json");
  // Selected display/operator preferences, never credentials or arbitrary host state.
  const temporarySettings = `${settingsFile}.${process.pid}.tmp`;
  writeFileSync(temporarySettings, `${JSON.stringify(resolveWorkbenchGuestSettings(hostSettings), null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporarySettings, settingsFile);
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
    result = await runSmolvmWorkbench({
      image: config.image,
      workspaceRoot,
      stateRoot: config.stateRoot,
      command: ["/usr/local/bin/0", WORKBENCH_INNER_ARGUMENT, ...args],
      environment,
      network,
      tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
      cpus: config.cpus,
      memoryMb: config.memoryMb,
      storageGb: config.storageGb,
      signal: controller.signal,
      approvedImages: config.approvedImages ?? [],
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGHUP", hangup);
  }
  if (result.cleanupFailed) {
    process.stderr.write("[0] SmolVM cleanup could not be proven. Workbench admission/state is retained; host execution is refused.\n");
    return 125;
  }
  if (result.error) process.stderr.write(`[0] ${result.error}\n`);
  if (result.timedOut) return 124;
  return signalCode ?? result.exitCode ?? 125;
}

export function selectWorkbenchProfile(profile: "local" | "smolvm", home?: string): void {
  if (!saveSettings({ ...loadGlobalSettings(home), executionProfile: profile }, home)) throw new Error("Could not persist the operator execution profile.");
}

