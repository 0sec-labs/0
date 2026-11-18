import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { ToolExecutor, TOOL_DEFINITIONS } from "../tools.js";
import { clearSkillRegistry, loadSkillRegistry } from "./index.js";
import type { ToolContext } from "../types.js";
import { eventBus } from "../../events/bus.js";
import type { EventSink } from "../../events/bus.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Build a minimal ToolContext for skill-integration tests. Includes
 * recentToolResultTexts and loadedSkills for loop-level integration.
 */
function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    target: "http://localhost:1234",
    scanId: "test-scan",
    findings: [],
    attackResults: [],
    targetInfo: {},
    role: "attack",
    recentToolResultTexts: [],
    loadedSkills: new Set<string>(),
    ...overrides,
  };
}

describe("Skill Integration (#458)", () => {
  let savedJitSkills: string | undefined;

  beforeEach(() => {
    savedJitSkills = process.env["ZERO_FEATURE_JIT_SKILLS"];
    process.env["ZERO_FEATURE_JIT_SKILLS"] = "1";
    clearSkillRegistry();
    loadSkillRegistry(__dirname);
  });

  afterEach(() => {
    if (savedJitSkills === undefined) delete process.env["ZERO_FEATURE_JIT_SKILLS"];
    else process.env["ZERO_FEATURE_JIT_SKILLS"] = savedJitSkills;
    clearSkillRegistry();
    eventBus.clear();
  });

  // ── loadedSkills persistence across turns ────────────────────────

  describe("loadedSkills persistence across turns", () => {
    it("loadedSkills set persists across multiple tool calls", async () => {
      const ctx = makeCtx();
      const executor = new ToolExecutor(ctx);

      // Load first skill
      const r1 = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "sqli-advanced" },
      });
      expect(r1.success).toBe(true);
      expect((r1.output as { kind: string }).kind).toBe("skill_loaded");
      expect(ctx.loadedSkills!.has("sqli-advanced")).toBe(true);

      // Load a different skill
      const r2 = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "jwt-attacks" },
      });
      expect(r2.success).toBe(true);
      expect((r2.output as { kind: string }).kind).toBe("skill_loaded");
      expect(ctx.loadedSkills!.has("jwt-attacks")).toBe(true);

      // Both should still be tracked
      expect(ctx.loadedSkills!.size).toBe(2);
      expect(ctx.loadedSkills!.has("sqli-advanced")).toBe(true);
      expect(ctx.loadedSkills!.has("jwt-attacks")).toBe(true);

      // Re-loading the first skill should return already_loaded
      const r3 = await executor.execute({
        name: "load_skill",
        arguments: { skill_id: "sqli-advanced" },
      });
      expect(r3.success).toBe(true);
      expect((r3.output as { kind: string }).kind).toBe("already_loaded");

      // Set size unchanged — no double-add
      expect(ctx.loadedSkills!.size).toBe(2);
    });

    it("loadedSkills survives executor recreation with same context", async () => {
      const ctx = makeCtx();

      // First "turn" — create executor, load skill
      const exec1 = new ToolExecutor(ctx);
      await exec1.execute({
        name: "load_skill",
        arguments: { skill_id: "prototype-pollution" },
      });
      expect(ctx.loadedSkills!.has("prototype-pollution")).toBe(true);

      // Simulate new turn — recreate executor with the same ctx (as the
      // loop does when the ToolContext is shared across turns)
      const exec2 = new ToolExecutor(ctx);
      const r = await exec2.execute({
        name: "load_skill",
        arguments: { skill_id: "prototype-pollution" },
      });
      expect(r.success).toBe(true);
      expect((r.output as { kind: string }).kind).toBe("already_loaded");
    });
  });

  // ── Event bus emissions ──────────────────────────────────────────

  describe("event bus emissions", () => {

    it("emits skill_loaded event on successful load_skill", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const spy: EventSink = {
        emit(type, payload) {
          events.push({ type, payload });
        },
      };
      const unsub = eventBus.subscribe(spy);

      try {
        const executor = new ToolExecutor(makeCtx());
        await executor.execute({
          name: "load_skill",
          arguments: { skill_id: "sqli-advanced" },
        });

        const loaded = events.filter((e) => e.type === "skill_loaded");
        expect(loaded.length).toBe(1);
        expect(loaded[0].payload.skill_id).toBe("sqli-advanced");
        expect(loaded[0].payload.name).toBe("Advanced SQL Injection");
        expect(typeof loaded[0].payload.estimated_tokens).toBe("number");
        expect(loaded[0].payload.role).toBe("attack");
      } finally {
        unsub();
      }
    });

    it("does not emit skill_loaded on already-loaded skill", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const spy: EventSink = {
        emit(type, payload) {
          events.push({ type, payload });
        },
      };
      const unsub = eventBus.subscribe(spy);

      try {
        const ctx = makeCtx({ loadedSkills: new Set(["sqli-advanced"]) });
        const executor = new ToolExecutor(ctx);
        await executor.execute({
          name: "load_skill",
          arguments: { skill_id: "sqli-advanced" },
        });

        const loaded = events.filter((e) => e.type === "skill_loaded");
        expect(loaded.length).toBe(0);
      } finally {
        unsub();
      }
    });

    it("does not emit skill_loaded on unknown skill", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const spy: EventSink = {
        emit(type, payload) {
          events.push({ type, payload });
        },
      };
      const unsub = eventBus.subscribe(spy);

      try {
        const executor = new ToolExecutor(makeCtx());
        await executor.execute({
          name: "load_skill",
          arguments: { skill_id: "does-not-exist" },
        });

        const loaded = events.filter((e) => e.type === "skill_loaded");
        expect(loaded.length).toBe(0);
      } finally {
        unsub();
      }
    });
  });
});
