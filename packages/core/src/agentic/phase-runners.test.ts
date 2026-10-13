import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { runNativeAttack } from "./phase-runners.js";
import type {
  NativeRuntime,
  NativeRuntimeResult,
  NativeToolDef,
} from "../runtime/types.js";
import type { ScanConfig } from "@0/shared";

// Keep the engine's hunt-memory default from writing to the real ~/.0 store
// (same guard as native-loop.test.ts).
beforeEach(() => {
  process.env["ZERO_DISABLE_HUNT_MEMORY"] = "1";
});
afterEach(() => {
  delete process.env["ZERO_DISABLE_HUNT_MEMORY"];
});

interface CapturedCall {
  system: string;
  toolNames: string[];
}

/**
 * Runtime that records the system prompt + advertised tool names, then ends
 * the loop immediately via the `done` tool. The assertions are on what the
 * attack stage hands the model — that IS the contract under test (the whole
 * point of the authenticated-web fix is which tools carry the session).
 */
function capturingRuntime(): { runtime: NativeRuntime; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const runtime: NativeRuntime = {
    type: "api",
    isAvailable: async () => true,
    async executeNative(system, _messages, tools: NativeToolDef[]): Promise<NativeRuntimeResult> {
      calls.push({ system, toolNames: tools.map((t) => t.name) });
      return {
        content: [
          { type: "tool_use", id: "done-1", name: "done", input: { summary: "Attack pass complete." } },
        ],
        stopReason: "tool_use",
        durationMs: 1,
      };
    },
  };
  return { runtime, calls };
}

function webConfig(overrides: Partial<ScanConfig>): ScanConfig {
  return {
    target: "https://console.example.test",
    mode: "web",
    depth: "quick",
    format: "json",
    ...overrides,
  } as ScanConfig;
}

// runNativeAttack's db parameter is typed `any` upstream, so a precise stub
// object passes without a cast.
const dbStub = { getSession: () => undefined, logEvent: () => {}, saveSession: () => {} };
const emit = () => {};

describe("runNativeAttack — authenticated web tool routing", () => {
  it("gives an authenticated web scan the structured session-carrying toolset", async () => {
    const { runtime, calls } = capturingRuntime();
    await runNativeAttack(
      runtime,
      dbStub,
      webConfig({ auth: { type: "cookie", value: "session=test-cookie" } }),
      randomUUID(),
      {},
      ["xss"],
      5,
      emit,
    );

    expect(calls.length).toBeGreaterThan(0);
    const { system, toolNames } = calls[0]!;
    // Structured HTTP tools — these are the ones wired to the SessionEngine
    // (cookies/auth headers/scope/rate limiting). The shell-first path used
    // to omit them, so authenticated scans replayed as anonymous curls.
    expect(toolNames).toContain("http_request");
    expect(toolNames).toContain("access_control_probe");
    expect(system).toContain("senior web application penetration tester");
    expect(system).toContain("Authenticated requests are configured");
    // Credentials must never reach model-visible text.
    expect(system).not.toContain("session=test-cookie");
    // Shell-first prompt marker — must NOT be the authenticated path.
    expect(system).not.toContain("Bundle paralysis");
  });

  it("advertises access-control guidance when multiple identities are configured", async () => {
    const { runtime, calls } = capturingRuntime();
    await runNativeAttack(
      runtime,
      dbStub,
      webConfig({
        identities: [
          { label: "alice", auth: { type: "bearer", token: "alice-secret" } },
          { label: "bob", auth: { type: "bearer", token: "bob-secret" } },
        ],
      }),
      randomUUID(),
      {},
      ["idor"],
      5,
      emit,
    );

    const { system, toolNames } = calls[0]!;
    expect(toolNames).toContain("http_request");
    expect(toolNames).toContain("access_control_probe");
    expect(system).toContain("Multi-Identity Access-Control Testing");
    expect(system).not.toContain("alice-secret");
    expect(system).not.toContain("bob-secret");
  });

  it("keeps the shell-first toolset for UNAUTHENTICATED web scans", async () => {
    const { runtime, calls } = capturingRuntime();
    await runNativeAttack(
      runtime,
      dbStub,
      webConfig({}),
      randomUUID(),
      {},
      ["xss"],
      5,
      emit,
    );

    const { system, toolNames } = calls[0]!;
    // Benchmark/CTF behaviour is unchanged: bash freedom, no structured
    // session tools advertised.
    expect(toolNames).toContain("bash");
    expect(toolNames).not.toContain("http_request");
    expect(system).toContain("Bundle paralysis");
  });
});
