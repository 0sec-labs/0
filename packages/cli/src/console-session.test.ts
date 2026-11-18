import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { osecDB } from "@0/engine/storage";
import type { NativeRuntime, NativeRuntimeResult } from "@0/engine";
import { createLocalConsoleSession } from "./console-session.js";
import { createConversationHistory } from "./conversation-history.js";
import { saveSession } from "./state/session-store.js";

function toolRuntime(name: string, input: Record<string, unknown>): NativeRuntime {
  const script: NativeRuntimeResult[] = [
    { content: [{ type: "tool_use", id: "history-call", name, input }], stopReason: "tool_use", durationMs: 0 },
    { content: [{ type: "text", text: "Done." }], stopReason: "end_turn", durationMs: 0 },
  ];
  return {
    type: "api",
    isAvailable: async () => true,
    executeNative: async () => {
      const result = script.shift();
      if (!result) throw new Error("Unexpected model call");
      return result;
    },
  };
}

const directories: string[] = [];
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "0-console-history-"));
  directories.push(directory);
  return join(directory, "findings.db");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local console persistent history", () => {
  it.each(["recon", "standard", "copilot"] as const)("reads saved conversations without approval in %s mode", async (autonomyMode) => {
    const path = databasePath();
    const home = dirname(path);
    expect(saveSession({
      id: "prior-conversation",
      cwd: "/history-project",
      savedAt: 1,
      preview: "",
      messageCount: 1,
      messages: [{ role: "assistant", content: "Earlier investigation result" }],
    }, home)).toBe(true);
    const session = createLocalConsoleSession({
      autonomyMode,
      runtime: toolRuntime("read_conversation", { session_id: "prior-conversation" }),
      conversationHistory: createConversationHistory({ homeDir: home, cwd: "/history-project" }),
    }, path, { homeDir: home });
    try {
      const outcome = await session.send("Read the earlier conversation");
      expect(outcome.toolCalls[0].result).toMatchObject({
        success: true,
        output: { messages: [{ text: "Earlier investigation result" }] },
      });
    } finally {
      await session.cleanup();
    }
  });
});
