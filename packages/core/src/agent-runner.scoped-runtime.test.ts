import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cliConfigs: [] as Array<Record<string, unknown>>,
  apiConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("./runtime/registry.js", () => ({
  detectAvailableRuntimes: vi.fn(async () => new Set(["codex"])),
  pickRuntimeForStage: vi.fn(() => "codex"),
}));

vi.mock("./runtime/process.js", () => ({
  ProcessRuntime: class {
    constructor(config: Record<string, unknown>) {
      state.cliConfigs.push(config);
    }
  },
}));

vi.mock("./agent/native-loop.js", () => ({
  runNativeAgentLoop: vi.fn(),
}));

vi.mock("./runtime/llm-api.js", () => ({
  LlmApiRuntime: class {
    constructor(config: Record<string, unknown>) { state.apiConfigs.push(config); }
    getConfigurationDiagnostics() {
      return { valid: true, provider: "openai", providerLabel: "OpenAI" };
    }

    async executeNative() {
      throw new Error("native loop mock should intercept execution");
    }
  },
}));

vi.mock("../events/bus.js", () => ({
  eventBus: { emit: () => {}, on: () => () => {} },
}));

import { runNativeAgentLoop } from "./agent/native-loop.js";
import { runAnalysisAgent } from "./agent-runner.js";

const mockedLoop = vi.mocked(runNativeAgentLoop);

function opts(): Parameters<typeof runAnalysisAgent>[0] {
  return {
    role: "audit",
    scopePath: "/scope",
    target: "lodash",
    scanId: "scan-test",
    config: { runtime: "codex", timeout: 10_000 },
    db: null,
    emit: () => {},
    cliPrompt: "audit",
    agentSystemPrompt: "sys",
    cliSystemPrompt: "cli sys",
  };
}

describe("runAnalysisAgent — scoped source runtime boundary", () => {
  beforeEach(() => {
    state.cliConfigs.length = 0; state.apiConfigs.length = 0;
    // The runtime itself is mocked below; this test must not depend on a
    // credential-shaped fixture to exercise routing.
    mockedLoop.mockResolvedValue({
      findings: [],
      summary: "done",
      turnCount: 1,
      done: true,
      messages: [],
      totalUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      costCeilingExceeded: false,
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("never spawns an available CLI in an attacker-controlled source scope", async () => {
    await runAnalysisAgent(opts());

    expect(state.cliConfigs).toEqual([]);
  });
  it("retains explicit API access-program intent and metadata callbacks inside the scoped native loop", async () => {
    const input = opts();
    const observe = vi.fn();
    input.config = { ...input.config, runtime: "api", provider: "openai", cyberAccessProgram: "daybreak_blue", onAccessProgram: observe };
    await runAnalysisAgent(input);
    expect(state.cliConfigs).toEqual([]);
    expect(state.apiConfigs).toContainEqual(expect.objectContaining({ type: "api", provider: "openai", cyberAccessProgram: "daybreak_blue", onAccessProgram: observe }));
    expect(mockedLoop).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ scopePath: "/scope" }) }));
  });

});
