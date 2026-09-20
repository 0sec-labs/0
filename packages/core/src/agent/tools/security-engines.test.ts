import { describe, it, expect } from "vitest";
import { getToolsForRole } from "../tools.js";

// These helpers must not widen the attacker-controlled source-review boundary.
const SECURITY_ENGINE_TOOLS = [
  "ad_attack_paths",
  "entra_attack_paths",
  "entra_posture",
  "assemble_advisory",
  "cve_lookup",
] as const;

describe("security-engine tools (dev-live-engine-recovery)", () => {

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
