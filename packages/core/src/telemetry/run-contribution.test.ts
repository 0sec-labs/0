import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureNativeRuntime, RunContributionClient, withRunContribution, type ContributionChunk, type ContributionReceipt } from "./run-contribution.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import { spawnSync } from "node:child_process";
import { createConsoleSession } from "../console/turn-engine.js";
import { runNativeAgentLoop } from "../agent/native-loop.js";
import { ScopePolicy } from "../scope/scope.js";
import { EnforcementTracker, PathPolicy } from "../scope/enforcement.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(fetchImpl?: typeof fetch, maxSpoolBytes = 2 * 1024 * 1024, maxChunkBytes = 32768) {
  const directory = mkdtempSync(join(tmpdir(), "0sec-contribution-test-"));
  directories.push(directory);
  const env: NodeJS.ProcessEnv = { "0SEC_ANALYTICS_LEVEL": "off" };
  let receipt: ContributionReceipt | null = {
    schemaVersion: 1, id: "synthetic-receipt", orgId: "synthetic-org", authorizedBy: "synthetic-admin", authority: "organization_admin",
    policyId: "synthetic-policy", termsId: "synthetic-only-not-production", status: "active",
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    purposes: ["operational", "internal_evaluation", "harness_improvement"],
    capture: { modelContent: true, toolContent: true, scopeContent: true },
  };
  const client = new RunContributionClient({
    policy: { policyId: "synthetic-policy", adoptedTermsIds: ["synthetic-only-not-production"], region: "synthetic-local", spoolRetentionMs: 3600_000, maxSpoolBytes, maxChunkBytes, maxTransitionsPerChunk: 2 },
    orgId: "synthetic-org", spoolDir: join(directory, "spool"), env,
    enrollment: () => receipt, credentials: () => ({ host: "http://127.0.0.1:12345", token: "synthetic-test-token" }), fetch: fetchImpl,
  });
  return { client, env, get receipt() { return receipt; }, set receipt(value) { receipt = value; } };
}
const begin = { runId: "synthetic-run", attemptId: "synthetic-attempt", model: "synthetic-model", scope: { owned: true }, objective: "Synthetic contract regression" };

describe("permissioned run contributions", () => {
  it("does not turn analytics or billing into contribution permission; independently enforces purposes", () => {
    const f = fixture();
    f.env["0SEC_ANALYTICS_LEVEL"] = "full";
    f.receipt = null;
    expect(f.client.begin(begin)).toBeNull();
    const permitted = fixture();
    expect(permitted.client.permission(undefined, "harness_improvement")).not.toBeNull();
    expect(permitted.client.permission(undefined, "model_training")).toBeNull();
    expect(permitted.client.permission(undefined, "licensing")).toBeNull();
    expect(permitted.client.begin(begin)?.manifest.execution).toBe("running");
  });

  it("keeps denied and offline data durable without issuing even a status request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const f = fixture(fetchImpl);
    const capture = f.client.begin(begin)!;
    capture.record("tool_result", { output: "owned result" });
    capture.finish("interrupted", "operator_cancelled");
    f.env["0SEC_OFFLINE"] = "1";
    expect((await f.client.upload(capture)).status).toBe("offline");
    delete f.env["0SEC_OFFLINE"];
    f.receipt = { ...f.receipt!, status: "blocked" };
    expect((await f.client.upload(capture)).status).toBe("denied");
    f.receipt = { ...f.receipt!, status: "active", expiresAt: new Date(Date.now() - 1).toISOString() };
    expect((await f.client.upload(capture)).status).toBe("denied");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.client.recover(begin.runId, begin.attemptId).load().transitions[0]?.data.output).toBe("owned result");
  });

  it("preserves live reasoning roundtrip while excluding opaque reasoning and exact credentials from private storage", async () => {
    const f = fixture();
    const capture = f.client.begin({ ...begin, authSecretValues: ["not-a-shaped-secret"] })!;
    const providerRaw = { provider: "openai", model: "synthetic-model", wireApi: "responses", output: [{ type: "reasoning", encrypted_content: "opaque-private-value", summary: [{ text: "visible summary" }] }] };
    const messages: NativeMessage[] = [{ role: "assistant", content: [{ type: "text", text: "not-a-shaped-secret" }], providerRaw }];
    const result: NativeRuntimeResult = { content: [{ type: "text", text: "a".repeat(5000) }], stopReason: "end_turn", durationMs: 1, providerRaw, usage: { inputTokens: 7, outputTokens: 9 } };
    const native: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async (_system, actual) => { expect(actual).toBe(messages); expect(actual[0]?.providerRaw).toBe(providerRaw); return result; } };
    expect(await captureNativeRuntime(native, capture).executeNative("system", messages, [])).toBe(result);
    capture.finish("completed", "plan_exhausted");
    const persisted = readFileSync(join(capture.directory, "transitions.jsonl"), "utf8");
    expect(persisted).not.toContain("opaque-private-value");
    expect(persisted).not.toContain("not-a-shaped-secret");
    expect(persisted).toContain("a".repeat(5000));
    expect(result.providerRaw).toBe(providerRaw);
    expect(capture.load().manifest.usage).toMatchObject({ inputTokens: 7, outputTokens: 9, costUsd: null });
    expect(statSync(capture.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(capture.directory, "transitions.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("orders nested agents globally and does not convert an unverified claim into a security result", async () => {
    const f = fixture();
    const capture = f.client.begin(begin)!;
    await withRunContribution(capture, "parent", null, async () => {
      capture.record("tool_call", { callId: "call", tool: "owned-tool" });
      await withRunContribution(capture, "child", "parent", async () => { capture.record("model_output", { claim: "exploited" }); });
      capture.record("tool_result", { callId: "call", success: false, error: "contract error" });
    });
    capture.finish("completed", "plan_exhausted");
    const { manifest, transitions } = capture.load();
    expect(transitions.map(t => [t.sequence, t.agentId, t.parentAgentId])).toEqual([[0, "parent", null], [1, "child", "parent"], [2, "parent", null], [3, "root", null]]);
    expect(manifest.securityOutcome).toBe("not_tested");
    expect(manifest.verification).toBe("not_run");
    expect(() => capture.recordSignal("correction", { evidenceRef: "replay" })).toThrow();
    capture.recordSignal("verification", { adjudicator: "independent-fixture-oracle", evidenceRef: "owned-replay", verdict: "timeout" }, { verification: "inconclusive", securityOutcome: "inconclusive" });
    expect(capture.load().manifest.verification).toBe("inconclusive");
  });

  it("resumes after a lost acknowledgement without resending accepted chunks, then rechecks revocation", async () => {
    let next = 0;
    let complete = false;
    let loseAck = true;
    const accepted: ContributionChunk[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method !== "POST") return Response.json({ nextChunkIndex: next, complete });
      const chunk = JSON.parse(String(init.body)) as ContributionChunk;
      expect(chunk.chunkIndex).toBe(next);
      accepted.push(chunk); next++; complete = chunk.final;
      if (loseAck) { loseAck = false; throw new Error("connection lost after commit"); }
      return Response.json({ accepted: true, nextChunkIndex: next });
    };
    const f = fixture(fetchImpl);
    const capture = f.client.begin(begin)!;
    capture.record("tool_call", { callId: "one" }); capture.record("tool_result", { callId: "one", success: false });
    capture.record("checkpoint", { sessionId: "owned-checkpoint" }); capture.finish("interrupted", "tool_error");
    expect((await f.client.upload(capture)).status).toBe("pending");
    const recovered = f.client.recover(begin.runId, begin.attemptId);
    expect((await f.client.upload(recovered)).status).toBe("uploaded");
    expect(accepted.map(c => c.chunkIndex)).toEqual([0, 1]);
    expect(accepted[1]?.final).toBe(true);
    expect(() => recovered.recordSignal("verification", { adjudicator: "oracle", evidenceRef: "replay" })).toThrow();
    f.receipt = { ...f.receipt!, status: "withdrawn" };
    expect((await f.client.upload(recovered)).status).toBe("denied");
  });

  it("marks a bounded spool partial but leaves room for immutable upload chunks", () => {
    const f = fixture(undefined, 131072);
    const capture = f.client.begin(begin)!;
    for (let index = 0; index < 100; index++) capture.record("tool_result", { index, output: "owned data ".repeat(300) });
    capture.finish("completed", "plan_exhausted");
    const chunks = capture.seal();
    expect(capture.manifest.quality).toContain("truncated");
    expect(capture.manifest.quality).not.toContain("complete");
    expect(chunks.flatMap(c => c.transitions).some(t => t.kind === "truncation" && t.data.reason === "spool_capacity")).toBe(true);
    expect(f.client.spoolBytes()).toBeLessThan(f.client.policy.maxSpoolBytes);
  });

  it("recovers an abrupt ending as interrupted and rejects changed sealed bytes", () => {
    const f = fixture();
    const capture = f.client.begin(begin)!;
    capture.record("tool_call", { callId: "in-flight" });
    const recovered = f.client.recover(begin.runId, begin.attemptId);
    expect(recovered.load().manifest).toMatchObject({ execution: "interrupted", termination: "unknown", verification: "not_run", usage: { costUsd: null } });
    const chunks = recovered.seal();
    chunks[0]!.transitions[0]!.data = { altered: true };
    writeFileSync(join(capture.directory, "chunks.json"), JSON.stringify(chunks));
    expect(() => recovered.seal()).toThrow("Corrupt sealed contribution");
  });

  it("drops opaque Anthropic blocks and contextually redacts credentials without changing live provider inputs", async () => {
    const f = fixture();
    const capture = f.client.begin(begin)!;
    const opaque = { type: "redacted_thinking", data: "opaque-anthropic-sentinel" };
    const messages: NativeMessage[] = [{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "owned", input: {
      password: "unguessable-but-not-token-shaped", headers: { Cookie: "sid=cookie-sentinel" },
      headerPairs: [["Authorization", "nonstandard-auth-sentinel"]], headerList: [{ name: "Set-Cookie", value: "other-cookie-sentinel" }],
    } }], providerRaw: { provider: "anthropic", model: "synthetic", wireApi: "messages", output: [opaque] } }];
    const result: NativeRuntimeResult = { content: [], stopReason: "end_turn", durationMs: 1, providerRaw: messages[0]!.providerRaw };
    const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async (_system, input) => {
      expect(input).toBe(messages); expect(input[0]!.providerRaw!.output[0]).toBe(opaque);
      const block = input[0]!.content[0]!;
      if (block.type !== "tool_use") throw new Error("Expected native tool arguments");
      expect(block.input.password).toBe("unguessable-but-not-token-shaped");
      return result;
    } };
    expect(await captureNativeRuntime(runtime, capture).executeNative("system", messages, [])).toBe(result);
    capture.finish("completed", "plan_exhausted");
    const chunks = JSON.stringify(capture.seal());
    const disk = readFileSync(join(capture.directory, "transitions.jsonl"), "utf8");
    for (const secret of ["opaque-anthropic-sentinel", "unguessable-but-not-token-shaped", "cookie-sentinel", "nonstandard-auth-sentinel", "other-cookie-sentinel"]) {
      expect(chunks).not.toContain(secret); expect(disk).not.toContain(secret);
    }
    expect(opaque.data).toBe("opaque-anthropic-sentinel");
  });

  it("flushes dead-owner partial attempts but leaves current live captures running", async () => {
    let complete = false;
    let next = 0;
    const f = fixture(async (_url, init) => {
      if (init?.method !== "POST") return Response.json({ nextChunkIndex: next, complete });
      const chunk = JSON.parse(String(init.body)) as ContributionChunk;
      complete = chunk.final; next++;
      return Response.json({ accepted: true, nextChunkIndex: next });
    });
    const capture = f.client.begin(begin)!;
    capture.record("tool_call", { callId: "pending-side-effect" });
    expect(await f.client.flush()).toEqual([]);
    expect(capture.manifest.execution).toBe("running");
    const deadOwner = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    expect(deadOwner).toBeGreaterThan(0);
    const path = join(capture.directory, "manifest.json");
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    metadata.ownerPid = deadOwner;
    writeFileSync(path, JSON.stringify(metadata));
    expect((await f.client.flush())[0]?.status).toBe("uploaded");
    const recovered = f.client.recover(begin.runId, begin.attemptId).load();
    expect(recovered.manifest.execution).toBe("interrupted");
    expect(recovered.transitions.filter(t => t.kind === "tool_call")).toHaveLength(1);
    expect(complete).toBe(true);
  });

  it("captures the real console tool loop and a native child under one parent", async () => {
    vi.stubEnv("0SEC_DISABLE_HUNT_MEMORY", "1");
    const f = fixture(undefined, 16 * 1024 * 1024, 2 * 1024 * 1024);
    const capture = f.client.begin(begin)!;
    let turn = 0;
    const child: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async () => ({
      content: [{ type: "tool_use", id: "child-done", name: "done", input: { summary: "Owned child complete" } }], stopReason: "tool_use", durationMs: 1,
    }) };
    const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, forkForSubagent: async () => child, executeNative: async () => ++turn === 1 ? {
      content: [{ type: "tool_use", id: "lookup", name: "payload_lookup", input: { name: "jsfuck_alert" } },
        { type: "tool_use", id: "spawn", name: "spawn_agent", input: { task: "Finish the owned synthetic child", max_turns: 1 } }],
      stopReason: "tool_use", durationMs: 1,
    } : { content: [{ type: "text", text: "Complete" }], stopReason: "end_turn", durationMs: 1 } };
    const session = createConsoleSession({ runtime, contribution: capture, autonomyMode: "yolo", refineObjective: false, allowModelSelfExtension: false });
    try {
      const outcome = await session.send("Exercise owned tools");
      expect(outcome.toolCalls.find(entry => entry.call.name === "payload_lookup")?.result.success).toBe(true);
      expect(outcome.toolCalls.find(entry => entry.call.name === "spawn_agent")?.result.success).toBe(true);
    } finally { await session.cleanup(); }
    const loaded = capture.load();
    const parent = loaded.transitions.find(t => t.kind === "model_input" && t.parentAgentId === null)!;
    expect(parent.agentId).toMatch(/^console-/);
    expect(loaded.transitions.some(t => t.kind === "model_input" && t.parentAgentId === parent.agentId)).toBe(true);
    expect(loaded.transitions.some(t => t.kind === "tool_result" && t.agentId === parent.agentId)).toBe(true);
    expect(loaded.manifest.execution).toBe("completed");
    const ordinary = createConsoleSession({ runtime: child, refineObjective: false, allowModelSelfExtension: false });
    try { expect(ordinary.contribution).toBeUndefined(); } finally { await ordinary.cleanup(); }
  });

  it("binds actual native host exclusions and normalized path enforcement into scope hashes", async () => {
    vi.stubEnv("0SEC_DISABLE_HUNT_MEMORY", "1");
    const scopes: Array<{ hash: string; scope: unknown }> = [];
    for (const excluded of ["blocked.example", "other.example"]) {
      const f = fixture();
      const capture = f.client.begin(begin)!;
      await runNativeAgentLoop({ contribution: capture, db: null,
        config: { role: "attack", scanId: begin.runId, target: "https://owned.example", systemPrompt: "owned", tools: [], maxTurns: 1, allowModelSelfExtension: false,
          scope: new ScopePolicy({ in_scope: ["owned.example"], out_of_scope: [excluded] }),
          enforcement: new EnforcementTracker({ pathPolicy: new PathPolicy(["/owned/"]), killAfterSec: 60 }) },
        runtime: { type: "api", isAvailable: async () => true, executeNative: async () => ({ content: [{ type: "tool_use", id: "done", name: "done", input: { summary: "done" } }], stopReason: "tool_use", durationMs: 1 }) },
      });
      scopes.push({ hash: capture.manifest.scopeHash, scope: capture.manifest.scope });
    }
    expect(scopes[0]!.hash).not.toBe(scopes[1]!.hash);
    expect(scopes[0]!.scope).toMatchObject({ policy: { out_of_scope: ["blocked.example"] }, enforcement: { pathPrefixes: ["/owned"], killAfterSec: 60 } });
  });

  it.each([true, false])("records actual same-turn inline oracle evidence, including inconclusive=%s", async inconclusive => {
    vi.stubEnv("0SEC_DISABLE_HUNT_MEMORY", "1");
    vi.stubEnv("0SEC_FEATURE_INLINE_VALIDATION", "1");
    const f = fixture();
    const capture = f.client.begin(begin)!;
    await runNativeAgentLoop({ contribution: capture, db: null,
      config: { role: "attack", scanId: begin.runId, target: "https://t", systemPrompt: "owned", tools: [], maxTurns: 1, allowModelSelfExtension: false },
      runtime: { type: "api", isAvailable: async () => true, executeNative: async () => ({
        content: [{ type: "tool_use", id: "save", name: "save_finding", input: { title: "Owned SQLi", severity: "high", category: "sql-injection", evidence_request: "GET /search?q=foo' HTTP/1.1\\nHost: t\\n\\n", evidence_response: "SQL syntax error near foo" } },
          { type: "tool_use", id: "done", name: "done", input: { summary: "done" } }], stopReason: "tool_use", durationMs: 1,
      }) },
      inlineValidationOracle: async () => {
        if (inconclusive) throw new Error("oracle timed out");
        return { verified: true, confidence: 1, evidence: "independent-sql-error-control", reason: "" };
      },
    });
    const loaded = capture.load();
    expect(loaded.manifest.verification).toBe(inconclusive ? "inconclusive" : "reproduced");
    expect(loaded.transitions.find(t => t.kind === "verification")?.data.source).toBe("inline_validation");
    if (!inconclusive) expect(JSON.stringify(loaded.transitions)).toContain("independent-sql-error-control");
  });
});
