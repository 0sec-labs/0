import { randomUUID } from "node:crypto";
import { createConsoleSession, type ConsoleSession, type ConsoleSessionConfig } from "@0/core";
import { osecDB } from "@0/db";
import { createConversationHistory } from "./conversation-history.js";
import { withDevEngineUpdates } from "./dev-engine-updates.js";

/** Local frontends share the findings store with history and own its connection. */
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
