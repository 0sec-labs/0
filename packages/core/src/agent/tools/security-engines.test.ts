import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./index.js";
import { TOOL_DISPATCH } from "./dispatch.js";
import { securityEngineToolDefinitions, securityEngineDispatch } from "./security-engines.js";
import { getToolsForRole } from "../tools.js";

// The seven offline / read-only security engines exposed as agent tools
// (dev-live-engine-recovery). File/DB read or read-only + env-scoped — no target
// network, no exploit — so they join the DEFAULT read-only role set with no new
// gating.
const SECURITY_ENGINE_TOOLS = [
  "ad_attack_paths",
  "entra_attack_paths",
  "entra_posture",
  "deep_source_review",
  "file_security_review",
  "assemble_advisory",
  "cve_lookup",
] as const;

describe("security-engine tools (dev-live-engine-recovery)", () => {
  it("registers exactly the seven engines in the domain module", () => {
    expect(Object.keys(securityEngineToolDefinitions).sort()).toEqual([...SECURITY_ENGINE_TOOLS].sort());
    expect(Object.keys(securityEngineDispatch).sort()).toEqual([...SECURITY_ENGINE_TOOLS].sort());
  });

  it("each engine appears in TOOL_DEFINITIONS with a matching name + description", () => {
    for (const name of SECURITY_ENGINE_TOOLS) {
      const def = TOOL_DEFINITIONS[name];
      expect(def, `${name} should be in TOOL_DEFINITIONS`).toBeDefined();
      expect(def.name).toBe(name);
      expect(def.description).toBeTruthy();
    }
  });

  it("each engine is in TOOL_REGISTRY_ORDER (the canonical, ordered key set)", () => {
    // TOOL_DEFINITIONS is assembled by mapping TOOL_REGISTRY_ORDER, so its keys
    // ARE the registry order — membership here proves the order carries them.
    const order = Object.keys(TOOL_DEFINITIONS);
    for (const name of SECURITY_ENGINE_TOOLS) {
      expect(order, `${name} should be in the registry order`).toContain(name);
    }
  });

  it("each engine is dispatchable (TOOL_DISPATCH → a real ToolExecutor method)", () => {
    // Parity with tools/dispatch.test.ts: every definition needs a dispatch
    // route. The method existence is proven by dispatch.test.ts against the
    // executor prototype; here we assert the route is present + non-empty.
    for (const name of SECURITY_ENGINE_TOOLS) {
      expect(TOOL_DISPATCH[name], `${name} should have a dispatch route`).toBeTruthy();
    }
  });

  it("is present for the trusted (non-scoped) read-only role, ABSENT inside a scope", () => {
    // The engines join the TRUSTED audit/review role (no scope → allEnabledTools),
    // but are deliberately kept OUT of the ATTACKER-CONTROLLED scoped source
    // boundary — several spawn sub-analyses / run lenses / make network calls, so
    // exposing them inside a hostile scope would widen the trust surface.
    for (const role of ["audit", "review"]) {
      // Present in the no-scope "everything" set for the same roles.
      const everything = getToolsForRole(role).map((t) => t.name);
      for (const name of SECURITY_ENGINE_TOOLS) {
        expect(everything, `${name} should be offered to ${role} (no scope)`).toContain(name);
      }
      // Absent from the scoped source-audit set (the security boundary).
      const scoped = getToolsForRole(role, { hasScope: true }).map((t) => t.name);
      for (const name of SECURITY_ENGINE_TOOLS) {
        expect(scoped, `${name} must be absent from scoped ${role}`).not.toContain(name);
      }
    }
  });

  it("does not gate the engines behind allowScanners (non-scoped role)", () => {
    // They are offline/read-only, not scanner-traffic — present in the trusted
    // (non-scoped) role regardless of allowScanners.
    const withoutScanners = getToolsForRole("audit").map((t) => t.name);
    for (const name of SECURITY_ENGINE_TOOLS) {
      expect(withoutScanners).toContain(name);
    }
  });
});
