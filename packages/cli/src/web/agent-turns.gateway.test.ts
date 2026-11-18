import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleSession, type NativeMessage, type NativeRuntime, type NativeRuntimeResult, type NativeToolDef } from "@0/engine";
import { SecurityWorkflowStore, SentinelStore } from "@0/engine/storage";
import { createSecurityWorkflowTemplate } from "@0/engine/shared";
import { ConsoleGateway } from "./console-gateway.js";
import { AgentTurnDelivery } from "./agent-turns.js";

vi.mock("../console-mcp.js", () => ({ connectConsoleMcp: async () => undefined }));

/** Planner calls report a large prompt so the next turn compacts; calls without tools are the summarizer. */
class CompactionRuntime implements NativeRuntime {
  readonly type = "api" as const;
  planner: NativeMessage[][] = [];
  summarizerCalls = 0;
  async isAvailable() { return true; }
  async executeNative(_system: string, messages: NativeMessage[], tools: NativeToolDef[]): Promise<NativeRuntimeResult> {
    if (tools.length === 0) { this.summarizerCalls += 1; return { content: [{ type: "text", text: "Concise recap of the conversation so far. ".repeat(4) }], stopReason: "end_turn", durationMs: 1, usage: { inputTokens: 20, outputTokens: 30 } }; }
    this.planner.push(structuredClone(messages));
    return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", durationMs: 1, usage: { inputTokens: 90_000, outputTokens: 1 } };
  }
}
const seeded = (): NativeMessage[] => Array.from({ length: 14 }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: index === 0 ? "FIRST-ANCHOR: an old request" : `seed message ${index}` }] }) as NativeMessage);
const textOf = (message: NativeMessage | undefined) => (message?.content ?? []).map(block => block.type === "text" ? block.text : "").join("\n");

const dirs: string[] = [];
const gateways: ConsoleGateway[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.closeAll())); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("agent turns through a real gateway with compaction forced", () => {
  it("sends the current charter in the turn that follows a compaction, and the earlier envelope is no longer what the model relies on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zero-agent-turns-")); dirs.push(dir);
    const dbPath = join(dir, "control.db");
    const runtime = new CompactionRuntime();
    const gateway = new ConsoleGateway({
      homeDir: dir, projectPath: dir, createId: (() => { let n = 0; return () => `home-${++n}`; })(),
      createSession: input => createConsoleSession({ runtime, refineObjective: false, contextWindowTokens: 100_000, compaction: { enabled: true, thresholdFraction: 0.8 }, initialMessages: input.initialMessages?.length ? input.initialMessages : seeded(), scanId: input.scanId, workspaceRoot: input.workspaceRoot }),
    });
    gateways.push(gateway);
    const store = new SentinelStore(dbPath);
    const workflows = new SecurityWorkflowStore(dbPath);
    const agent = store.create({ name: "Guard", instructions: "Review dependencies." });
    store.setStatus(agent.id, "active", undefined, true);
    const automation = workflows.save({ ...createSecurityWorkflowTemplate("dependency-review", { target: "." }), ownerSentinelId: agent.id });
    const trigger = store.createTrigger(agent.id, { automationId: automation.id, kind: "schedule", schedule: { frequency: "minutes", every: 5 }, enabled: true });
    const delivery = new AgentTurnDelivery({
      store, now: Date.now,
      missions: {
        create: input => gateway.create(input),
        send: (id, text, author, mode, automated) => gateway.send(id, { text, ...(mode ? { mode } : {}) }, author, automated ? { automated: true } : undefined),
        pendingDecisions: id => gateway.get(id).pendingDecisions.length,
        subscribe: (id, listener) => gateway.subscribe(id, event => listener(event as unknown as { type: string })),
        usage: id => gateway.get(id).usage,
        exists: id => { try { gateway.get(id); return true; } catch { return false; } },
        removeQueued: (id, messageId) => gateway.removeQueued(id, messageId),
      },
      ensureHome: async sentinel => { if (sentinel.homeMissionId) return { id: sentinel.homeMissionId, replaced: false }; const created = gateway.create({ title: `Sentinel: ${sentinel.name}` }); store.setHomeMission(sentinel.id, created.id); return { id: created.id, replaced: false }; },
    });
    const request = (key: string, at: string) => ({ sentinel: store.get(agent.id)!, origin: "schedule" as const, via: "schedule", trigger: { id: trigger.id, kind: "schedule" as const }, automation, idempotencyKey: key, scheduledFor: at });
    const settled = (turnId: string) => vi.waitFor(() => expect(store.getTurn(turnId)?.status).toBe("completed"), { timeout: 10_000 });

    const first = await delivery.deliver(request("k1", "2026-03-02T10:00:00.000Z"));
    expect(first.status).toBe("queued");
    if (first.status !== "queued") return;
    await settled(first.turn.id);
    expect(runtime.summarizerCalls).toBe(0);
    expect(textOf(runtime.planner[0]!.at(-1))).toContain("Review dependencies.");

    // The charter and scope are edited between turns. The next turn compacts first, then must carry the edit.
    const charter = store.getFile(agent.id, "AGENTS.md")!;
    store.putFile(agent.id, "AGENTS.md", `${charter.content}\n- NEW-CHARTER-RULE-77: never open network connections to unlisted hosts.\n`, charter.revision, "human", "local");
    const second = await delivery.deliver(request("k2", "2026-03-02T10:05:00.000Z"));
    expect(second.status).toBe("queued");
    if (second.status !== "queued") return;
    await settled(second.turn.id);

    expect(runtime.summarizerCalls).toBe(1);
    const afterCompaction = runtime.planner[1]!;
    expect(afterCompaction.some(message => textOf(message).includes("[COMPACTED CONVERSATION SUMMARY]"))).toBe(true);
    const turnMessage = textOf(afterCompaction.at(-1));
    expect(turnMessage).toContain("NEW-CHARTER-RULE-77");
    expect(turnMessage).toContain("Hard limits");
    expect(turnMessage).toContain("Your charter was edited since your last turn");
    // The first turn's envelope was part of what compaction was free to summarise; the rule only exists in the new envelope.
    expect(afterCompaction.slice(0, -1).some(message => textOf(message).includes("NEW-CHARTER-RULE-77"))).toBe(false);
    expect(store.listTurns(agent.id).filter(turn => turn.status === "completed")).toHaveLength(2);
    expect(second.turn.sessionId).toBe(first.turn.sessionId);
    store.close(); workflows.close();
  });
});
