import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function fakeCli(command: string, events: object[], exitCode: number): string {
  const bin = mkdtempSync(join(realpathSync(tmpdir()), "0-agent-cli-"));
  dirs.push(bin);
  writeFileSync(join(bin, "stream.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, "argv.txt")}"\ncat "${join(bin, "stream.jsonl")}"\nexit ${exitCode}\n`);
  chmodSync(join(bin, command), 0o755);
  process.env.PATH = [bin, originalPath].join(delimiter);
  return bin;
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


describe("ProcessRuntime Codex cyber access program", () => {
  const events = [{ type: "item.completed", item: { type: "agent_message", text: "Source review complete." } }];

  it.each(["standard", "daybreak_blue", "daybreak_red"] as const)("passes explicit %s separately from the model and retains requested-only metadata", async cyberAccessProgram => {
    const bin = fakeCli("codex", events, 0);
    const result = await new ProcessRuntime({ type: "codex", timeout: 10_000, model: "gpt-fixture", cyberAccessProgram }).execute("Review source.");
    const args = readFileSync(join(bin, "argv.txt"), "utf8").trim().split("\n");
    expect(args.slice(args.indexOf("--cyber-access-program"), args.indexOf("--cyber-access-program") + 2)).toEqual(["--cyber-access-program", cyberAccessProgram]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-fixture"]);
    expect(result.accessProgram).toEqual({ requested: cyberAccessProgram });
    expect(result.output).toBe("Source review complete.");
  });

  it("preserves server defaults when no program is explicitly selected, even for a cyber model alias", async () => {
    const bin = fakeCli("codex", events, 0);
    const result = await new ProcessRuntime({ type: "codex", timeout: 10_000, model: "gpt-daybreak-blue-latest" }).execute("Review source.");
    expect(readFileSync(join(bin, "argv.txt"), "utf8")).not.toContain("--cyber-access-program");
    expect(result.accessProgram).toBeUndefined();
  });

  it("retains requested metadata on cancellation without starting a subprocess", async () => {
    const bin = fakeCli("codex", events, 0);
    const result = await new ProcessRuntime({ type: "codex", timeout: 10_000, cyberAccessProgram: "daybreak_blue" }).execute("Review source.", { signal: AbortSignal.abort() });
    expect(result.error).toBe("Runtime execution cancelled.");
    expect(result.accessProgram).toEqual({ requested: "daybreak_blue" });
    expect(existsSync(join(bin, "argv.txt"))).toBe(false);
  });

  it("rejects invalid programs and unsupported runtimes before spawning", () => {
    expect(() => new ProcessRuntime({ type: "codex", timeout: 10_000, cyberAccessProgram: "blue" as never })).toThrow("Invalid cyber access program");
    expect(() => new ProcessRuntime({ type: "claude", timeout: 10_000, cyberAccessProgram: "daybreak_blue" })).toThrow("--runtime codex");
  });

  it("retains requested treatment and surfaces a terminal policy failure without treating prior text as success", async () => {
    fakeCli("codex", [...events, { type: "turn.failed", error: { message: "cyber_policy: request refused" } }], 1);
    const result = await new ProcessRuntime({ type: "codex", timeout: 10_000, cyberAccessProgram: "daybreak_blue" }).execute("Review source.");
    expect(result.error).toBe("cyber_policy: request refused");
    expect(result.output).toBe("");
    expect(result.accessProgram).toEqual({ requested: "daybreak_blue" });
  });
});
