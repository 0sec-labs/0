import { existsSync, realpathSync } from "node:fs";
import { createWorkbenchProviderBroker, isAdmittedSmolvmWorkbench } from "@0/core";
import type { ConsoleSession, ConsoleSessionConfig, LlmApiRuntime } from "@0/core";
import { findingSchema, type ConsoleExecutionSnapshot } from "@0/shared";
import { osecDB } from "@0/db";
import { randomUUID } from "node:crypto";
import { currentWorkbenchAssets } from "./workbench-assets.js";
import { loadGlobalSettings } from "./tui/settings.js";
import { loadWorkbenchConfig, workbenchConfigPath, workbenchNetworkEnabled, resolveWorkbenchGuestSettings } from "./workbench.js";
import { createWorkbenchConsoleSession } from "./workbench-console-session.js";

export interface ConsoleExecutionOptions {
  homeDir?: string;
  dbPath?: string;
  workspaceRoot?: string;
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
  if (!workbench) throw new Error("SmolVM is selected but no workbench is configured. Run 0 workbench setup --image <approved archive>. Host fallback is refused.");
  if (config.pluginHost || config.mcpHost) throw new Error("Host plugin and MCP resources cannot be forwarded into SmolVM. Configure tools inside the approved guest image.");
  const runtime = config.runtime as Partial<LlmApiRuntime>;
  const provider = runtime.resolvedProvider?.();
  const model = runtime.resolvedModel?.() ?? config.costModel;
  if (provider !== "chatgpt-codex" || !model) throw new Error("The isolated console currently requires the brokered chatgpt-codex provider and an explicit resolved model. Host fallback is refused.");
  if (!workbench.providers.includes(provider)) throw new Error("The selected provider is not granted to this workbench. Configure an explicit chatgpt-codex provider grant.");
  const routing = runtime.modelSelection?.();
  const models = [...new Set([model, ...Object.values(routing?.agentModels ?? {}).filter(value => value !== "auto")])];
  if (!runtime.workbenchCredentialResolver) throw new Error("The selected runtime cannot bind its account to the host provider broker.");
  const broker = createWorkbenchProviderBroker({ provider, models, resolveCredentials: runtime.workbenchCredentialResolver() });
  const { runtime: _runtime, ...guestConfig } = config;
  const scanId = config.scanId ?? `console-${randomUUID()}`;
  try {
    return createWorkbenchConsoleSession({
      config: { ...guestConfig, scanId, workspaceRoot: realpathSync(workbench.workspaceRoot ?? options.workspaceRoot ?? config.workspaceRoot ?? process.cwd()) },
      workbench,
      selection: { provider, model, contextWindowTokens: config.contextWindowTokens, ...routing },
      provider: { ...broker.grant, request: broker.request, close: broker.close },
      assets: currentWorkbenchAssets(), guestSettings: resolveWorkbenchGuestSettings(loadGlobalSettings(options.homeDir)),
      network: workbenchNetworkEnabled(),
      onExecution: options.onExecution,
      onFindings: (findings, completion) => {
        // No host store is opened until the VM has stopped and native teardown is proven.
        const validated = findings.map(finding => findingSchema.parse(finding));
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
