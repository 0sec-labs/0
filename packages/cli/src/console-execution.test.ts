import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleSessionConfig, LlmApiRuntime } from "@0/core";
import type { Finding } from "@0/shared";
import { osecDB, LearningStore, learningProjectId } from "@0/db";
import type { WorkbenchConsoleSessionOptions } from "./workbench-console-session.js";
const fixture = vi.hoisted(() => ({ workspace: "", home: "", broker: vi.fn(), proxy: vi.fn(), settings: vi.fn(), assets: vi.fn() }));
vi.mock("@0/core", async original => ({ ...await original<object>(), createWorkbenchProviderBroker: fixture.broker }));
vi.mock("./tui/settings.js", () => ({ loadGlobalSettings: fixture.settings }));
vi.mock("./workbench-assets.js", () => ({ currentWorkbenchAssets: fixture.assets }));
vi.mock("./workbench-console-session.js", () => ({ createWorkbenchConsoleSession: fixture.proxy }));
vi.mock("./workbench.js", () => ({
  workbenchConfigPath: () => join(fixture.home, "workbench.json"),
  loadWorkbenchConfig: () => ({ providers: ["chatgpt-codex"], workspaceRoot: fixture.workspace }),
  resolveWorkbenchGuestSettings: (settings: unknown) => settings,
  workbenchNetworkEnabled: () => true,
}));
import { createIsolatedConsoleSession } from "./console-execution.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "0-console-import-test-"))); roots.push(root);
  fixture.home = root; fixture.workspace = root;
  fixture.settings.mockReset().mockReturnValue({ executionProfile: "smolvm", updatePolicy: "off" });
  fixture.assets.mockReset().mockReturnValue({ cliDist: join(root, "approved-assets") });
  fixture.proxy.mockReset().mockReturnValue({});
  fixture.broker.mockReset().mockReturnValue({ grant: { protocol: 1, provider: "chatgpt-codex", models: ["primary", "review"] }, request: vi.fn(), close: vi.fn() });
  const credentialResolver = vi.fn(async () => ({ accessToken: "host-only-fixture-token" }));
  const runtime = {
    resolvedProvider: () => "chatgpt-codex", resolvedModel: () => "primary",
    modelSelection: () => ({ agentModels: { audit: "auto", review: "review" }, singleModel: false, autoRoute: true }),
    workbenchCredentialResolver: () => credentialResolver,
  } as unknown as LlmApiRuntime;
  const dbPath = join(root, "results.sqlite");
  createIsolatedConsoleSession({ runtime, scanId: "import-fixture", target: "https://target.test", workspaceRoot: root } as ConsoleSessionConfig,
    { homeDir: root, dbPath, workspaceRoot: root });
  return { root, dbPath, credentialResolver, input: fixture.proxy.mock.calls[0][0] as WorkbenchConsoleSessionOptions };
}

describe("isolated console result import", () => {
  it("retains only validated source metadata in the explicit host learning database", async () => {
    const { input, dbPath, root } = setup();
    const sourceLinks = [{ path: "src/app.ts", hash: `sha256:${"a".repeat(64)}` }];
    const context = { workspaceRoot: root, scanId: "import-fixture", runId: "vm-run" };
    await input.onSourceContext!({ sourceLinks }, context);
    await input.onSourceContext!({ sourceLinks }, context);
    const store = new LearningStore(dbPath);
    try {
      expect(store.listEvents({ projectId: learningProjectId(root) })).toEqual([
        expect.objectContaining({ kind: "source-context", evidenceStrength: "hypothesis", sourceLinks, runId: "vm-run" }),
      ]);
      expect(store.listKnowledge()).toEqual([]);
    } finally { store.close(); }
  });
  it("honors the source-memory disable switch before opening a host store", async () => {
    const { input, dbPath, root } = setup();
    vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "true");
    try {
      await input.onSourceContext!({ sourceLinks: [] }, { workspaceRoot: root, scanId: "import-fixture", runId: "vm-run" });
      expect(existsSync(dbPath)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects invalid findings before opening the host store and grants no guest credentials", () => {
    const { input, dbPath, credentialResolver } = setup();
    expect(existsSync(dbPath)).toBe(false);
    expect(() => input.onFindings!([{ id: "invalid" } as Finding])).toThrow();
    expect(existsSync(dbPath)).toBe(false);
    expect(fixture.broker).toHaveBeenCalledWith({ provider: "chatgpt-codex", models: ["primary", "review"], resolveCredentials: credentialResolver });
    expect(credentialResolver).not.toHaveBeenCalled();
    expect(input.config).not.toHaveProperty("runtime");
    expect(JSON.stringify(input)).not.toContain("host-only-fixture-token");
    expect(input.assets).toEqual({ cliDist: expect.stringContaining("approved-assets") });
    expect(fixture.settings).toHaveBeenCalledWith(fixture.home, expect.anything());
  });

  it("imports a genuine completed outcome into the explicit host database after the proxy handoff", () => {
    const { input, dbPath } = setup();
    expect(existsSync(dbPath)).toBe(false);
    const finding: Finding = { id: "finding-fixture", templateId: "fixture", title: "Observed issue", description: "Bounded fixture evidence",
      severity: "low", category: "missing-validation", status: "discovered", evidence: { request: "fixture", response: "observed" }, timestamp: Date.now() };
    input.onFindings!([finding], { outcome: { stopReason: "end_turn", assistantText: "Verified fixture", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
      budget: { tokensUsed: 2, tokenBudget: 100, iterations: 1, maxToolIterations: 10 } } });
    const db = new osecDB(dbPath);
    try { expect(db.getScan("import-fixture")?.status).toBe("completed"); expect(db.getFindings("import-fixture")[0].id).toBe("finding-fixture"); }
    finally { db.close(); }
  });
});
