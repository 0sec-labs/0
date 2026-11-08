import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ProcessRuntime } from "./process.js";

// Claude Code prints these events when it has no login, then exits 1 with empty stderr.
const LOGGED_OUT = [
  { type: "system", subtype: "init", model: "claude-opus-5-5" },
  { type: "assistant", error: "authentication_failed", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] } },
  { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", total_cost_usd: 0 },
];

// An error result can follow model text, and it can come without `result` text.
const ERROR_AFTER_TEXT = [
  { type: "assistant", message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Checking the target." }] } },
  { type: "result", subtype: "success", is_error: true },
];

const COMPLETED = [
  { type: "assistant", message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Checking the target." }] } },
  { type: "result", subtype: "success", is_error: false, result: '{"findings":[]}' },
];

const originalPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCli(command: string, events: object[], exitCode: number): void {
  const bin = mkdtempSync(join(realpathSync(tmpdir()), "0-agent-cli-"));
  dirs.push(bin);
  writeFileSync(join(bin, "stream.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  writeFileSync(join(bin, command), `#!/bin/sh\ncat "${join(bin, "stream.jsonl")}"\nexit ${exitCode}\n`);
  chmodSync(join(bin, command), 0o755);
  process.env.PATH = [bin, originalPath].join(delimiter);
}

describe("ProcessRuntime claude", () => {
  it("reports a Claude Code error result as a runtime error, not as model output", async () => {
    fakeCli("claude", LOGGED_OUT, 1);
    const onThinking = vi.fn();

    const result = await new ProcessRuntime({ type: "claude", timeout: 10_000, onThinking }).execute("Assess the target.");

    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("Not logged in · Please run /login");
    expect(result.output).toBe("");
    expect(onThinking).not.toHaveBeenCalled();
  });

  it("drops the model text of a run that ends in an error result", async () => {
    fakeCli("claude", ERROR_AFTER_TEXT, 1);

    const result = await new ProcessRuntime({ type: "claude", timeout: 10_000 }).execute("Assess the target.");

    expect(result.output).toBe("");
    expect(result.error).toBe("Claude Code returned an error result.");
  });

  it("returns the final result text of a completed run", async () => {
    fakeCli("claude", COMPLETED, 0);

    const result = await new ProcessRuntime({ type: "claude", timeout: 10_000 }).execute("Assess the target.");

    expect(result.output).toBe('{"findings":[]}');
    expect(result.error).toBeUndefined();
  });
});

describe("ProcessRuntime gemini", () => {
  it("does not return the raw event stream after an error result", async () => {
    fakeCli("gemini", [{ type: "result", status: "error", error: { message: "quota exceeded" } }], 1);

    const result = await new ProcessRuntime({ type: "gemini", timeout: 10_000 }).execute("Assess the target.");

    expect(result.error).toBe("quota exceeded");
    expect(result.output).toBe("");
  });
});
