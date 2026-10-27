import { describe, expect, it } from "vitest";
import { SETTING_DEFS } from "../../src/tui/settings";
import { categoryFor, settingChoiceLabel, settingLabel, settingSurface, sharedSettingKeys, visibleWebSetting, webSettingDetails } from "../../../dashboard/src/components/console-control/web-settings";

describe("browser settings capability boundary", () => {
  it("exposes only shared runtime, conversation, and privacy preferences", () => {
    expect(SETTING_DEFS.filter(visibleWebSetting).map(definition => definition.key).sort()).toEqual([
      "allowModelSelfExtension", "allowSubagentOperatorMessaging", "allowSubagentPeerMessaging", "analyticsLevel", "autoCompaction", "busyInputMode", "compactionThreshold", "diagnosticReporting", "executionProfile", "updatePolicy",
    ].sort());
    for (const definition of SETTING_DEFS) expect(settingSurface(definition.key)).not.toBe("unsupported");
    expect(visibleWebSetting({ key: "new-terminal-feature" })).toBe(false);
    expect(settingSurface("new-terminal-feature")).toBe("unsupported");
  });
  it("keeps browser appearance separate from terminal presentation", () => {
    for (const key of ["web-theme", "web-motion"]) {
      expect(settingSurface(key)).toBe("browser");
      expect(visibleWebSetting({ key })).toBe(false);
    }
    for (const key of ["theme", "reduceMotion", "leaderKey", "showStatusBar", "autoEvolveFinderLenses", "allowDevSourceUpdates"]) expect(settingSurface(key)).toBe("terminal");
    expect(sharedSettingKeys(["theme", "web-theme", "reduceMotion", "web-motion", "allowDevSourceUpdates", "executionProfile", "analyticsLevel", "executionProfile", "unknown"])).toEqual(["executionProfile", "analyticsLevel"]);
    expect(sharedSettingKeys([])).toEqual([]);
  });
  it("uses reviewed web copy and categories instead of terminal metadata", () => {
    expect(categoryFor({ key: "busyInputMode" })).toBe("conversation");
    expect(categoryFor({ key: "executionProfile" })).toBe("agents");
    expect(categoryFor({ key: "analyticsLevel" })).toBe("privacy");
    expect(settingLabel({ key: "allowSubagentPeerMessaging", label: "CLI label" })).toBe("Agent collaboration");
    expect(webSettingDetails("allowSubagentPeerMessaging")?.description).toBe("Let agents exchange findings and coordinate their work.");
    expect(webSettingDetails("unknown")).toBeUndefined();
    expect(settingChoiceLabel("executionProfile", "smolvm")).toBe("Isolated workspace");
    expect(settingChoiceLabel("busyInputMode", "steer")).toBe("Interrupt");
    expect(settingChoiceLabel("diagnosticReporting", "off")).toBe("Keep local");
  });
});
