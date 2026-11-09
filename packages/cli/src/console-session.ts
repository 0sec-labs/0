import { randomUUID } from "node:crypto";
import { createConsoleJevRuntime, createConsoleSession, toToolContextJevRuntime, type ConsoleSession, type ConsoleSessionConfig } from "@0/core";
import { osecDB } from "@0/db";
import { createConversationHistory } from "./conversation-history.js";
import { withDevEngineUpdates } from "./dev-engine-updates.js";
import { consoleJevFeatures } from "./console-jev-features.js";
import { createIsolatedConsoleSession, type ConsoleExecutionOptions } from "./console-execution.js";

/** Local frontends share the findings store with history and own its connection. */
function consoleJevRuntimeFromEnvironment() {
  const features = consoleJevFeatures();
  return toToolContextJevRuntime(createConsoleJevRuntime({ provider: "direct", features }));
}

export function createLocalConsoleSession(
  config: Omit<ConsoleSessionConfig, "db">,
  dbPath?: string,
  options: ConsoleExecutionOptions = {},
): ConsoleSession {
  config = { ...config, codebaseLearning: config.codebaseLearning ?? true };
  const isolated = createIsolatedConsoleSession(config, { ...options, dbPath });
  if (isolated) return isolated;
  return createHostLocalConsoleSession(config, dbPath, options);
}

/** Explicit host execution for an already selected local-profile worker. */
export function createHostLocalConsoleSession(
  config: Omit<ConsoleSessionConfig, "db">,
  dbPath?: string,
  options: ConsoleExecutionOptions = {},
): ConsoleSession {
  options.onExecution?.({ backend: "local", status: "ready", workspacePath: options.workspaceRoot ?? config.workspaceRoot ?? process.cwd() });
  const db = new osecDB(dbPath);
  const scanId = config.scanId ?? `console-${randomUUID()}`;
  let ownsScan = false;
  try {
    if (!db.getScan(scanId)) {
      db.createScan({
        target: config.target ?? "",
        depth: "default",
        format: "terminal",
        runtime: "api",
      }, scanId);
      ownsScan = true;
    }
    const engineConfig: ConsoleSessionConfig = {
      ...config,
      codebaseLearning: config.codebaseLearning ?? true,
      scanId,
      db,
      conversationHistory: config.conversationHistory ?? createConversationHistory(),
      jevRuntime: config.jevRuntime ?? consoleJevRuntimeFromEnvironment(),
    };
    const session = createConsoleSession(engineConfig);
    return withDevEngineUpdates(session, engineConfig, (completed) => {
      try {
        if (completed && ownsScan) db.completeScan(scanId, { source: "console" });
      } finally {
        db.close();
      }
    });
  } catch (error) {
    try {
      if (ownsScan) db.failScan(scanId, error instanceof Error ? error.message : String(error));
    } finally {
      db.close();
    }
    throw error;
  }
}
