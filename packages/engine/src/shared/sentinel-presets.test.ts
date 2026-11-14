import { describe, expect, it } from "vitest";
import { loadSkillRegistry } from "../agent/skills/index.js";
import { SENTINEL_PRESETS, getSentinelPreset } from "./sentinel-presets.js";
import { SENTINEL_PRESET_IDS, parseSentinelCreate } from "./sentinels.js";
import { SECURITY_WORKFLOW_TEMPLATES } from "./security-workflow-templates.js";

describe("sentinel presets", () => {
  it("covers every preset id once", () => {
    expect(SENTINEL_PRESETS.map(preset => preset.id).sort()).toEqual([...SENTINEL_PRESET_IDS].sort());
    expect(SENTINEL_PRESET_IDS).toHaveLength(10);
    expect(getSentinelPreset("pen-tester")?.name).toBe("Pen Tester");
  });
  it("validates every preset against the Sentinel schema with safe defaults", () => {
    for (const preset of SENTINEL_PRESETS) {
      const parsed = parseSentinelCreate(preset.sentinel);
      expect(parsed.role).toBe(preset.id);
      expect(parsed.status).toBe("paused");
      expect(parsed.scope.production).toBe(false);
      expect(parsed.autonomy).not.toBe("act");
      expect(parsed.toolAccess).not.toBe("exec");
    }
  });
  it("resolves skill ids and automation templates against the real catalogs", () => {
    const registry = loadSkillRegistry();
    const templates = new Set(SECURITY_WORKFLOW_TEMPLATES.map(template => template.id));
    for (const preset of SENTINEL_PRESETS) {
      for (const skill of preset.sentinel.skills) expect(registry.has(skill), `${preset.id}: ${skill}`).toBe(true);
      for (const automation of preset.suggestedAutomations) {
        if (automation.templateId) expect(templates.has(automation.templateId), `${preset.id}: ${automation.templateId}`).toBe(true);
        expect(["schedule", "manual", "github-pr"]).toContain(automation.trigger.kind);
      }
    }
  });
  it("gives every preset an icon id, a short card description and no emoji", () => {
    for (const preset of SENTINEL_PRESETS) {
      expect(preset.avatar.icon, preset.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(preset.description.length, preset.id).toBeLessThanOrEqual(90);
      expect(JSON.stringify(preset)).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(parseSentinelCreate(preset.sentinel).avatar.icon).toBe(preset.avatar.icon);
    }
  });
  it("keeps read-only tools and propose or observe autonomy unless justified", () => {
    for (const preset of SENTINEL_PRESETS) expect(["propose", "observe"]).toContain(preset.autonomy);
    expect(SENTINEL_PRESETS.filter(preset => preset.sentinel.toolAccess !== "read-only").map(preset => preset.id).sort()).toEqual(["attack-surface-monitor", "pen-tester", "regression-tester"]);
  });
});
