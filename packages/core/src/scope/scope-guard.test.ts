import { describe, it, expect } from "vitest";
import { withScopeEnforcement, type ScopeEnforcementState } from "./activation.js";
import { describeScopeGuards, isScopeRequired, targetRequiresScope } from "./scope-guard.js";

const active: ScopeEnforcementState = { pluginId: "scope", enabled: true, projectPath: "/fixture", message: "enabled" };
const inactive: ScopeEnforcementState = { ...active, enabled: false, message: "disabled" };

describe("scope activation visibility", () => {
  it("does not report a configured policy as enforced while the plugin is disabled", () => {
    withScopeEnforcement(inactive, () => {
      const status = describeScopeGuards(true, { ZERO_REQUIRE_SCOPE: "1" });
      expect(status.pluginEnabled).toBe(false);
      expect(status.active).toBe(false);
      expect(status.required).toBe(false);
    });
  });

  it("enforces only configured policy and retains active missing-policy strictness", () => {
    withScopeEnforcement(active, () => {
      expect(describeScopeGuards(true, {}).active).toBe(true);
      const missing = describeScopeGuards(false, { ZERO_REQUIRE_SCOPE: "1" });
      expect(missing.pluginEnabled).toBe(true);
      expect(missing.active).toBe(false);
      expect(missing.required).toBe(true);
      expect(describeScopeGuards(false, {}).required).toBe(false);
    });
  });
});

describe("scope strictness and target classification", () => {
  it("accepts explicit strictness and rejects disabled spellings", () => {
    for (const raw of ["1", "true", "TRUE", "yes", " on "]) {
      expect(isScopeRequired({ ZERO_REQUIRE_SCOPE: raw })).toBe(true);
    }
    for (const raw of ["", "0", "false"]) {
      expect(isScopeRequired({ ZERO_REQUIRE_SCOPE: raw })).toBe(false);
    }
  });

  it("classifies live network targets separately from source targets", () => {
    expect(targetRequiresScope("https://example.com")).toBe(true);
    expect(targetRequiresScope("http://example.com")).toBe(true);
    expect(targetRequiresScope("mcp://example.com")).toBe(true);
    expect(targetRequiresScope("lodash")).toBe(false);
    expect(targetRequiresScope("./local-source")).toBe(false);
  });
});
