import { describe, expect, it } from "vitest";
import { SETTING_DEFS } from "../../cli/src/state/settings";
import { categoryFor, settingChoiceLabel, settingLabel, settingSurface, sharedSettingKeys, visibleWebSetting, webSettingDetails } from "../src/components/console-control/web-settings";

describe("browser settings capability boundary", () => {
  it("exposes only shared runtime, conversation, and privacy preferences", () => {
    expect(SETTING_DEFS.filter(visibleWebSetting).map(definition => definition.key).sort()).toEqual([
      "allowModelSelfExtension", "allowSubagentOperatorMessaging", "allowSubagentPeerMessaging", "analyticsLevel", "autoCompaction", "busyInputMode", "compactionThreshold", "diagnosticReporting", "elapsedTimer", "executionProfile", "showContextMeter", "showCost", "showSubagents", "showTimestamps", "showTokenUsage", "toolCardStyle", "transcriptDetail", "density", "updatePolicy",
    ].sort());
    for (const definition of SETTING_DEFS) expect(settingSurface(definition.key)).not.toBe("unsupported");
    expect(visibleWebSetting({ key: "new-terminal-feature" })).toBe(false);
    expect(settingSurface("new-terminal-feature")).toBe("unsupported");
  });
  it("exposes only settings the browser UI actually honours", () => {
    const wired = ["density", "transcriptDetail", "toolCardStyle", "showSubagents", "showTimestamps", "elapsedTimer", "showCost", "showTokenUsage", "showContextMeter"];
    for (const key of wired) expect(webSettingDetails(key)?.description, key).toBeTruthy();
    for (const key of ["theme", "allowDevSourceUpdates", "mouseSupport", "leaderKey"]) expect(visibleWebSetting({ key }), key).toBe(false);
  });
  it("keeps browser appearance separate from terminal presentation", () => {
    for (const key of ["web-theme"]) {
      expect(settingSurface(key)).toBe("browser");
      expect(visibleWebSetting({ key })).toBe(false);
    }
    expect(settingSurface("allowDevSourceUpdates")).toBe("terminal");
    expect(settingSurface("theme")).toBe("unsupported");
    for (const key of ["leaderKey", "showStatusBar", "autoEvolveFinderLenses"]) expect(settingSurface(key)).toBe("unsupported");
    expect(sharedSettingKeys(["theme", "web-theme", "allowDevSourceUpdates", "executionProfile", "analyticsLevel", "executionProfile", "unknown"])).toEqual(["executionProfile", "analyticsLevel"]);
    expect(sharedSettingKeys([])).toEqual([]);
  });
  it("uses reviewed web copy and categories instead of terminal metadata", () => {
    expect(categoryFor({ key: "busyInputMode" })).toBe("conversation");
    expect(categoryFor({ key: "executionProfile" })).toBe("agents");
    expect(categoryFor({ key: "analyticsLevel" })).toBe("privacy");
    expect(settingLabel({ key: "allowSubagentPeerMessaging", label: "CLI label" })).toBe("Agent collaboration");
    expect(webSettingDetails("allowSubagentPeerMessaging")?.description).toBe("Agents can share findings with one another.");
    expect(webSettingDetails("unknown")).toBeUndefined();
    expect(settingChoiceLabel("executionProfile", "smolvm")).toBe("Isolated workspace");
    expect(settingChoiceLabel("busyInputMode", "steer")).toBe("Interrupt");
    expect(settingChoiceLabel("diagnosticReporting", "off")).toBe("Keep local");
  });
});
