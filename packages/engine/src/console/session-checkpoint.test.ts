import { describe, expect, it } from "vitest";
import { createConsoleSession } from "./turn-engine.js";
import { consoleSessionCheckpointSchema } from "./session-checkpoint.js";
import type { NativeRuntime } from "../runtime/types.js";
import { LEGACY_ACCESS_VALUES } from "../shared/approvals.js";

const idle: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async () => { throw new Error("not used"); } };

describe("console checkpoint access value", () => {
  it("new checkpoints write the constant older readers accept", async () => {
    const session = createConsoleSession({ runtime: idle, allowModelSelfExtension: false, refineObjective: false });
    try {
      await session.ready;
      expect(session.exportCheckpoint().autonomyMode).toBe("changes");
    } finally { await session.cleanup(); }
  });

  it("every stored legacy value loads without error and is ignored", async () => {
    const session = createConsoleSession({ runtime: idle, allowModelSelfExtension: false, refineObjective: false });
    try {
      await session.ready;
      const base = JSON.parse(JSON.stringify(session.exportCheckpoint())) as Record<string, unknown>;
      for (const value of [...LEGACY_ACCESS_VALUES, undefined]) {
        const stored = { ...base, ...(value === undefined ? {} : { autonomyMode: value }) };
        if (value === undefined) delete stored["autonomyMode"];
        expect(() => consoleSessionCheckpointSchema.parse(stored), String(value)).not.toThrow();
      }
    } finally { await session.cleanup(); }
  });
});
