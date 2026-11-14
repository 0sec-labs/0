import { describe, it, expect } from "vitest";
import type { Finding, ScanConfig } from "../shared/index.js";
import type { NativeRuntime, NativeRuntimeResult, NativeMessage } from "../runtime/types.js";
import { runNativeVerify } from "./phase-runners.js";
import { gateVerdict, recordedOracle, runVerifyPlaybook, buildSkillVerifyPrompt, type SessionOutcome } from "./skill-verify.js";
import { features } from "../agent/features.js";

function mk(i: number, extra: Partial<Finding> = {}): Finding {
  return {
    id: `f-${i}`, templateId: `t-${i}`, title: `Finding ${i}`, description: "d", severity: "high",
    category: "sql-injection", status: "discovered", timestamp: 0,
    evidence: { request: `GET /v${i}?id=1 HTTP/1.1`, response: "200 OK", analysis: "a" }, ...extra,
  };
}
const VERIFIED = { verified: true, confidence: 1, evidence: "boom", reason: "" };
const REFUTED = { verified: false, confidence: 0, evidence: "", reason: "payload not reflected" };
const UNKNOWN = { verified: false, inconclusive: true, confidence: 0, evidence: "", reason: "transport" };

describe("gateVerdict", () => {
  const f = mk(1);
  it("oracle proof is non-overridable", () => {
    const v = gateVerdict(f, "false-positive", VERIFIED);
    expect(v).toMatchObject({ status: "confirmed", source: "oracle-gate", gateReason: "oracle_override_blocked" });
  });
  it("no model verdict reaches inconclusive, never unresolved", () => {
    expect(gateVerdict(f, undefined, undefined)).toMatchObject({ status: "inconclusive", source: "coverage-gate" });
    expect(gateVerdict(f, undefined, VERIFIED).status).toBe("confirmed");
  });
  it("confirmed against a definitive refuting oracle is held, inconclusive oracle is not", () => {
    expect(gateVerdict(f, "confirmed", REFUTED).status).toBe("inconclusive");
    expect(gateVerdict(f, "confirmed", UNKNOWN).status).toBe("confirmed");
    expect(gateVerdict(f, "false-positive", UNKNOWN).status).toBe("false-positive");
  });
});

describe("recordedOracle", () => {
  it("reconstructs the triage oracle layer without re-running it", () => {
    const lv = (verdict: any, reason: string) => ({ layer: "oracle" as const, verdict, reason, confidence: 0.9, durationMs: 0, costUsd: 0 });
    expect(recordedOracle(mk(1, { layerVerdicts: [lv("pass", "verified: x")] }))).toMatchObject({ verified: true, evidence: "x" });
    expect(recordedOracle(mk(1, { layerVerdicts: [lv("reject", "nope")] }))).toMatchObject({ verified: false });
    expect(recordedOracle(mk(1, { layerVerdicts: [lv("reject", 'no oracle for category="x"')] }))?.inconclusive).toBe(true);
    expect(recordedOracle(mk(1, { layerVerdicts: [lv("skip", "off")] }))).toBeUndefined();
    expect(recordedOracle(mk(1))).toBeUndefined();
  });
});

describe("runVerifyPlaybook", () => {
  it("runs one fresh session per finding and every finding gets exactly one terminal verdict", async () => {
    const findings = Array.from({ length: 10 }, (_, i) => mk(i + 1));
    const prompts: string[] = [];
    const session = async (_f: Finding, p: string): Promise<SessionOutcome> => {
      prompts.push(p);
      const n = prompts.length;
      return { turns: 1, modelStatus: n % 3 === 0 ? undefined : n % 2 ? "confirmed" : "false-positive" };
    };
    const { verdicts, turns } = await runVerifyPlaybook({ session, findings, target: "https://t.test", config: {} });
    expect(prompts).toHaveLength(10);
    expect(turns).toBe(10);
    expect(verdicts.map((v) => v.findingId)).toEqual(findings.map((f) => f.id));
    for (const v of verdicts) expect(["confirmed", "false-positive", "inconclusive"]).toContain(v.status);
    expect(verdicts.filter((v) => v.status === "inconclusive")).toHaveLength(3);
  });

  it("cost ceiling closes the remaining findings as inconclusive without more sessions", async () => {
    let calls = 0;
    const session = async (): Promise<SessionOutcome> => (++calls, { turns: 2, modelStatus: "confirmed", costCeilingExceeded: calls === 2 });
    const { verdicts } = await runVerifyPlaybook({ session, findings: [1, 2, 3, 4].map((i) => mk(i)), target: "t", config: {} });
    expect(calls).toBe(2);
    expect(verdicts.map((v) => v.status)).toEqual(["confirmed", "confirmed", "inconclusive", "inconclusive"]);
  });

  it("injects the oracle result read-only into the prompt and honours abort", async () => {
    const p = buildSkillVerifyPrompt("https://t.test", mk(1), VERIFIED, {});
    expect(p).toContain("Oracle result (read-only, computed by code)");
    expect(p).toContain('"verified":true');
    expect(buildSkillVerifyPrompt("t", mk(1), undefined, {})).toContain("none (no oracle ran");
    const ac = new AbortController();
    ac.abort();
    await expect(runVerifyPlaybook({ session: async () => ({ turns: 0 }), findings: [mk(1)], target: "t", config: { signal: ac.signal } })).rejects.toThrow();
  });
});

describe("flag dispatch in runNativeVerify", () => {
  const cfg = { target: "https://example.test", depth: "default", format: "json" } as ScanConfig;
  function rt(systems: string[]): NativeRuntime {
    return {
      type: "api", isAvailable: async () => true,
      async executeNative(system: string, _m: NativeMessage[]): Promise<NativeRuntimeResult> {
        systems.push(system);
        return { content: [{ type: "tool_use", id: "d", name: "done", input: { summary: "ok" } }], stopReason: "tool_use", durationMs: 1 };
      },
    };
  }
  it("is OFF by default and keeps the legacy prompt", async () => {
    delete process.env["ZERO_FEATURE_SKILL_VERIFY"];
    expect(features.skillVerify).toBe(false);
    const s: string[] = [];
    await runNativeVerify(rt(s), null, cfg, "s1", [mk(1)], () => {});
    expect(s[0]).toContain("Your job: verify ONE finding by replaying the attack");
    expect(s[0]).not.toContain("Skill: verify-with-oracle");
  });
  it("ZERO_FEATURE_SKILL_VERIFY=1 routes through the playbook runner", async () => {
    process.env["ZERO_FEATURE_SKILL_VERIFY"] = "1";
    try {
      const s: string[] = [];
      await runNativeVerify(rt(s), null, cfg, "s2", [mk(1), mk(2)], () => {});
      expect(s).toHaveLength(2);
      expect(s[1]).toContain("Skill: verify-with-oracle");
      expect(s[1]).toContain("id: f-2");
    } finally { delete process.env["ZERO_FEATURE_SKILL_VERIFY"]; }
  });
});
