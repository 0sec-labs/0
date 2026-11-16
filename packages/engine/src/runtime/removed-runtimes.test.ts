import { describe, expect, it } from "vitest";
import { createRuntime } from "./index.js";
import { removedRuntimeMessage } from "../shared/removed-runtimes.js";
import type { RuntimeConfig } from "./types.js";

describe("removed runtimes", () => {
  it.each(["ollama", "gemini"])("--runtime %s fails with the removal notice, not a crash or silent fallback", (type) => {
    expect(() => createRuntime({ type, timeout: 1_000 } as unknown as RuntimeConfig)).toThrow(`--runtime ${type} was removed in 0.35: use an OpenAI-compatible endpoint`);
  });

  it("an unknown runtime name is reported as unknown", () => {
    expect(removedRuntimeMessage("bogus")).toBe('Unknown runtime "bogus". Use api, claude, codex or auto.');
  });
});
