import { existsSync, realpathSync } from "node:fs";
import { createWorkbenchProviderBroker, isAdmittedSmolvmWorkbench } from "@0/engine";
import type { ConsoleRuntime, ConsoleSession, ConsoleSessionConfig } from "@0/engine";
import { findingSchema, type ConsoleExecutionSnapshot, type Finding } from "@0/engine/shared";
import { osecDB } from "@0/engine/storage";
import { randomUUID } from "node:crypto";
import { currentWorkbenchAssets } from "./workbench-assets.js";
import { loadGlobalSettings } from "./state/settings.js";
import { loadWorkbenchConfig, workbenchConfigPath, workbenchNetworkEnabled, resolveWorkbenchGuestSettings } from "./workbench.js";
import { createWorkbenchConsoleSession } from "./workbench-console-session.js";

export interface ConsoleExecutionOptions {
  homeDir?: string;
  dbPath?: string;
  workspaceRoot?: string;
  /** Trusted host/test asset selection; never read from browser or guest input. */
  assets?: { cliDist: string; dependencies?: string };
  onExecution?: (execution: ConsoleExecutionSnapshot) => void;
}

/** Host UI selection is independent of model/provider selection and guest admission. */
export function consoleExecutionProfile(homeDir?: string): "local" | "smolvm" {
  if (process.platform === "linux" && isAdmittedSmolvmWorkbench()) return "local";
  return loadGlobalSettings(homeDir, { requireExecutionProfile: existsSync(workbenchConfigPath(homeDir)) }).executionProfile;
}

/** All interactive frontends cross the same execution boundary before opening host tool resources. */
export function createIsolatedConsoleSession(
  config: Omit<ConsoleSessionConfig, "db">,
  options: ConsoleExecutionOptions = {},
): ConsoleSession | undefined {
  if (consoleExecutionProfile(options.homeDir) !== "smolvm") return undefined;
  const workbench = loadWorkbenchConfig(options.homeDir);
  if (!workbench) throw new Error("SmolVM is selected but no workbench is configured. Run 0 config doctor workbench setup --image <approved archive>. Host fallback is refused.");
  const requestedWorkspace = options.workspaceRoot ?? config.workspaceRoot;
  if (workbench.workspaceRoot && requestedWorkspace && realpathSync(workbench.workspaceRoot) !== realpathSync(requestedWorkspace)) throw new Error("This chat folder differs from the configured SmolVM workspace grant. Start a chat in the granted folder or explicitly reconfigure the workbench before execution.");
  if (config.mcpHost) throw new Error("Host MCP resources cannot be forwarded into SmolVM. Configure tools inside the approved guest image.");
  const runtime = config.runtime as Partial<ConsoleRuntime>;
  const provider = runtime.resolvedProvider?.();
  const model = runtime.resolvedModel?.() ?? config.costModel;
  if (provider !== "chatgpt-codex" || !model) throw new Error("The isolated console currently requires the brokered chatgpt-codex provider and an explicit resolved model. Host fallback is refused.");
  if (!workbench.providers.includes(provider)) throw new Error("The selected provider is not granted to this workbench. Configure an explicit chatgpt-codex provider grant.");
  const routing = runtime.modelSelection?.();
  const models = [...new Set([model, ...Object.values(routing?.agentModels ?? {}).filter(value => value !== "auto")])];
  if (!runtime.workbenchCredentialResolver) throw new Error("The selected runtime cannot bind its account to the host provider broker.");
  const broker = createWorkbenchProviderBroker({ provider, models, resolveCredentials: runtime.workbenchCredentialResolver() });
  // The isolated workbench has no Memory: notes live on the host, and nothing is read or written from inside the VM.
  const { runtime: _runtime, ...guestConfig } = config;
  guestConfig.codebaseLearning = false;
  const approvedWorkspace = realpathSync(workbench.workspaceRoot ?? options.workspaceRoot ?? config.workspaceRoot ?? process.cwd());
  const scanId = config.scanId ?? `console-${randomUUID()}`;
  try {
    return createWorkbenchConsoleSession({
      config: { ...guestConfig, scanId, workspaceRoot: approvedWorkspace },
      workbench,
      selection: { provider, model, contextWindowTokens: config.contextWindowTokens, ...routing },
      provider: { ...broker.grant, request: broker.request, close: broker.close },
      pluginHomeDir: options.homeDir, assets: options.assets ?? currentWorkbenchAssets(), guestSettings: resolveWorkbenchGuestSettings(loadGlobalSettings(options.homeDir)),
      network: workbenchNetworkEnabled(),
      onExecution: options.onExecution,
      onFindings: (findings, completion) => {
        // No host store is opened until the VM has stopped and native teardown is proven.
        const validated = findings.map(finding => findingSchema.parse(finding) as Finding);
        const db = new osecDB(options.dbPath);
        try {
          if (!db.getScan(scanId)) db.createScan({ target: config.target ?? "", depth: "default", format: "terminal", runtime: "api" }, scanId);
          for (const finding of validated) db.saveFinding(scanId, finding);
          if (!completion?.outcome || completion.outcome.stopReason === "error") db.failScan(scanId, completion?.outcome?.error ?? "Guest turn ended before a complete outcome was saved");
          else db.completeScan(scanId, { source: "console", execution: "smolvm", stopReason: completion.outcome.stopReason });
        } finally { db.close(); }
      },
    });
  } catch (error) {
    void broker.close();
    throw error;
  }
}
