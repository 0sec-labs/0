import { randomUUID } from "node:crypto";
import { createConsoleJevRuntime, createConsoleSession, toToolContextJevRuntime, type ConsoleSession, type ConsoleSessionConfig } from "@0/core";
import { osecDB } from "@0/db";
import { createConversationHistory } from "./conversation-history.js";
import { withDevEngineUpdates } from "./dev-engine-updates.js";
import type { JevFeature } from "@0/shared";

/** Local frontends share the findings store with history and own its connection. */
const CONSOLE_JEV_FEATURES = new Set<JevFeature>([
  "browser", "memory", "dedupe", "redteam", "kernel", "crash", "radar", "foxguard",
]);

function consoleJevRuntimeFromEnvironment() {
  const features = [...new Set(
    (process.env["ZERO_JEV_FEATURES"] ?? "").split(",")
      .map((feature) => feature.trim())
      .filter((feature): feature is JevFeature => CONSOLE_JEV_FEATURES.has(feature as JevFeature)),
  )];
  return toToolContextJevRuntime(createConsoleJevRuntime({ provider: "direct", features }));
}

export function createLocalConsoleSession(
  config: Omit<ConsoleSessionConfig, "db">,
  dbPath?: string,
): ConsoleSession {
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
