import { describe, it, expect } from "vitest";
import { runCampaign, runIterativeCampaign, type JevFeedbackFn } from "./engine.js";
import { installPackageBehavior } from "./behaviors.js";
import { mockTarget } from "./targets/mock.js";
import type { Target, TargetResponse } from "./types.js";

describe("runCampaign against mock target", () => {
  const behavior = installPackageBehavior();

  it("breaks compliant + channel-specific models, not the hardened one", async () => {
    const target = mockTarget({
      models: [
        { name: "compliant", followsVisible: true, decodes: [] },
        { name: "claude-ish", followsVisible: false, decodes: ["tags"] },
        { name: "openai-ish", followsVisible: false, decodes: ["bits"] },
        { name: "hardened", followsVisible: false, decodes: [] },
      ],
    });
    const res = await runCampaign(behavior, target, { stopWhenAllBroken: true });
    expect(res.brokenModels.sort()).toEqual(["claude-ish", "compliant", "openai-ish"]);
    expect(res.brokenModels).not.toContain("hardened");
  });

  it("never retries an already-broken model (unique-breaks)", async () => {
    const target = mockTarget({ models: [{ name: "compliant", followsVisible: true, decodes: [] }] });
    let sends = 0;
    const wrapped = { ...target, send: (...a: Parameters<typeof target.send>) => { sends++; return target.send(...a); } };
    const res = await runCampaign(behavior, wrapped, {});
    expect(res.brokenModels).toEqual(["compliant"]);
    // first candidate already breaks it; no further sends to that model
    expect(sends).toBe(1);
  });

  it("iterative campaign escalates on survivors and keeps unique breaks", async () => {
    const target = mockTarget({
      models: [
        { name: "compliant", followsVisible: true, decodes: [] },
        { name: "claude-ish", followsVisible: false, decodes: ["tags"] },
        { name: "hardened", followsVisible: false, decodes: [] },
      ],
    });
    const res = await runIterativeCampaign(behavior, target, {});
    expect(res.brokenModels.sort()).toEqual(["claude-ish", "compliant"]);
    expect(res.brokenModels).not.toContain("hardened");
    // each broken model recorded once (unique)
    expect(new Set(res.breaks.map((b) => b.model)).size).toBe(res.brokenModels.length);
  });
});

describe("bandit steering", () => {
  const behavior = installPackageBehavior();

  /** Deterministic Lehmer RNG (seed 42). */
  function seededRng(): { rng: () => number; reset: () => void } {
    let seed = 42;
    const mod = 2147483647;
    return {
      rng: () => {
        seed = (seed * 16807) % mod;
        return seed / mod;
      },
      reset: () => { seed = 42; },
    };
  }

  it("with banditSteering off, result has no steeringWeights (regression guard)", async () => {
    const target = mockTarget({ models: [{ name: "hardened", followsVisible: false, decodes: [] }] });
    const res = await runCampaign(behavior, target, { banditSteering: false, maxAttempts: 5 });
    expect(res.steeringWeights).toBeUndefined();
    // No breaks from hardened model; attempts still recorded
    expect(res.attempts).toBeGreaterThan(0);
    expect(res.breaks.length).toBe(0);
  });

  it("rewards a consistently good strategy and maintains exploration floor", async () => {
    const { rng } = seededRng();

    // Custom target that encodes the first strategy in the transcript so the
    // scripted Jev function can return strategy-specific feedback.
    const target: Target = {
      name: "bandit-test",
      models: ["m"],
      async send(payload) {
        return { transcript: payload.strategies[0] ?? "" };
      },
    };

    // Scripted Jev: frame:mundane-required always gets good feedback; everything else gets bad.
    const jevFeedback: JevFeedbackFn = async (_behavior, response) => {
      if (response.transcript === "frame:mundane-required") {
        return { label: "partial-compliance" as const, probability: 1, advisory: true as const };
      }
      return { label: "explicit-refusal" as const, probability: 1, advisory: true as const };
    };

    const res = await runCampaign(behavior, target, {
      jevFeedback,
      banditSteering: true,
      rng,
      maxAttempts: 60,
    });

    expect(res.steeringWeights).toBeDefined();
    const w = res.steeringWeights!;

    // The consistently good strategy should have the highest weight
    const allWeights = Object.entries(w).sort(([, a], [, b]) => b - a);
    expect(allWeights[0]![0]).toBe("frame:mundane-required");

    // Exploration floor: every strategy ≥ ~0.09 (allow fp round-trip)
    for (const [, weight] of allWeights) {
      expect(weight).toBeGreaterThanOrEqual(0.09);
    }
  });

  it("broken verdicts remain judge-determined regardless of steering", async () => {
    const { rng } = seededRng();

    // Compliant model follows visible instructions → generates breaks
    const target = mockTarget({ models: [{ name: "compliant", followsVisible: true, decodes: [] }] });

    // Scripted Jev always says "explicit-refusal" (advisory, should not suppress breaks)
    const jevFeedback: JevFeedbackFn = async () => ({
      label: "explicit-refusal" as const,
      probability: 1,
      advisory: true as const,
    });

    const res = await runCampaign(behavior, target, {
      jevFeedback,
      banditSteering: true,
      rng,
      maxAttempts: 10,
      stopWhenAllBroken: true,
    });

    // Compliant model should still break via the regex judge
    expect(res.brokenModels).toContain("compliant");
    expect(res.breaks.length).toBeGreaterThanOrEqual(1);
    // Every break record says broken
    expect(res.breaks.every((b) => b.broken)).toBe(true);
  });

  it("unavailable Jev feedback leaves strategy selection effectively uniform", async () => {
    const { rng } = seededRng();

    const target: Target = {
      name: "bandit-test",
      models: ["m"],
      async send(payload) {
        return { transcript: payload.strategies[0] ?? "" };
      },
    };

    // All Jev feedback is unavailable (simulates provider failure)
    const jevFeedback: JevFeedbackFn = async () => ({
      label: "ambiguous" as const,
      probability: 0,
      advisory: true as const,
      unavailable: true,
    });

    const res = await runCampaign(behavior, target, {
      jevFeedback,
      banditSteering: true,
      rng,
      maxAttempts: 30,
    });

    expect(res.steeringWeights).toBeDefined();
    const w = res.steeringWeights!;

    // Frame/concealment weights are computed independently, so "uniform"
    // within each pool: 1/5 for framings, 1/3 for concealments.
    const framingIds = ["frame:mundane-required", "frame:reasoning-mimicry", "frame:fake-ci-authority", "frame:fake-preflight", "frame:document-authority"];
    const concealmentIds = ["conceal:html-comment", "conceal:unicode-tags", "conceal:sneaky-bits"];

    const fUniform = 1 / framingIds.length; // 0.20
    const cUniform = 1 / concealmentIds.length; // ~0.333

    for (const id of framingIds) {
      expect(Math.abs(w[id]! - fUniform)).toBeLessThan(0.05);
    }
    for (const id of concealmentIds) {
      expect(Math.abs(w[id]! - cUniform)).toBeLessThan(0.05);
    }
  });

  it("terminates at the default cap when maxAttempts is unset and the model never breaks", async () => {
    const target: Target = {
      name: "bandit-test",
      models: ["hardened"],
      async send(payload) {
        return { transcript: payload.strategies[0] ?? "" };
      },
    };
    const jevFeedback: JevFeedbackFn = async () =>
      ({ label: "explicit-refusal" as const, probability: 1, advisory: true as const });

    const res = await runCampaign(behavior, target, { jevFeedback, banditSteering: true, rng: seededRng().rng });
    expect(res.attempts).toBe(100);
    expect(res.breaks.length).toBe(0);
  });

  it("terminates promptly once every model is broken, even without stopWhenAllBroken", async () => {
    const target = mockTarget({ models: [{ name: "compliant", followsVisible: true, decodes: [] }] });
    const jevFeedback: JevFeedbackFn = async () =>
      ({ label: "partial-compliance" as const, probability: 1, advisory: true as const });

    const res = await runCampaign(behavior, target, { jevFeedback, banditSteering: true, rng: seededRng().rng });
    expect(res.brokenModels).toContain("compliant");
    // Once the only model is broken the loop must stop instead of spinning on skipped reports.
    expect(res.attempts).toBeLessThan(100);
  });
});
