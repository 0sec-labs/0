/** Pure ordering and persistence contracts. Rendered navigation coverage lives
 * in test/tui-driver/scenarios/onboarding-navigation.tui.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SETTING_DEFS } from "./settings.js";
import {
  __resetSettingsStoreForTests,
  configureSettingsStore,
  getSettings,
  reloadSettings,
  updateSetting,
} from "./settings-store.js";
import {
  finalizeOnboarding,
  recordAnalyticsConsent,
  stepAfter,
  stepBefore,
  type OnboardingStep,
} from "./onboarding-screen.js";

const tempHomes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "0-onboarding-"));
  tempHomes.push(dir);
  return dir;
}

/** A theme choice guaranteed to differ from the default, so a change is visible. */
function otherThemeChoice(): string {
  const def = SETTING_DEFS.find((d) => d.key === "theme");
  const choices = def?.choices ?? [];
  const current = getSettings().theme;
  const other = choices.find((c) => c !== current);
  if (!other) throw new Error("expected more than one theme choice");
  return other;
}

beforeEach(() => {
  __resetSettingsStoreForTests();
});

afterEach(() => {
  __resetSettingsStoreForTests();
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("guided step machine", () => {
  it("walks every optional choice before explicit completion", () => {
    expect(stepAfter("welcome")).toBe("connect");
    expect(stepAfter("connect")).toBe("models");
    expect(stepAfter("models")).toBe("preferences");
    expect(stepAfter("preferences")).toBe("analytics");
    expect(stepAfter("analytics")).toBe("plugins");
    expect(stepAfter("plugins")).toBe("done");
    expect(stepAfter("done")).toBeUndefined();
  });

  it("can revisit every previous decision", () => {
    expect(stepBefore("welcome")).toBeUndefined();
    expect(stepBefore("connect")).toBe("welcome");
    expect(stepBefore("models")).toBe("connect");
    expect(stepBefore("preferences")).toBe("models");
    expect(stepBefore("analytics")).toBe("preferences");
    expect(stepBefore("plugins")).toBe("analytics");
    expect(stepBefore("done")).toBe("plugins");
  });

});

describe("completion is written in exactly one place", () => {
  it("stays false through connect, model, and preference steps — set only on done", () => {
    configureSettingsStore({ homeDir: makeHome() });
    expect(getSettings().onboardingCompleted).toBe(false);

    // Walk every intermediate step's effect. Connect/model stage on the audit
    // owner (no settings write); preferences persist via updateSetting.
    let step: OnboardingStep | undefined = "welcome";
    const theme = otherThemeChoice();
    while (step && step !== "done") {
      if (step === "preferences") {
        expect(updateSetting("theme", theme)).toBe(true);
        expect(updateSetting("density", "compact")).toBe(true);
      }
      if (step === "analytics") {
        // The analytics step's Enter persists consent — but NOT completion.
        recordAnalyticsConsent("usage");
      }
      // Reaching a step, skipping it, or setting a preference/consent must NOT
      // complete onboarding.
      expect(getSettings().onboardingCompleted).toBe(false);
      step = stepAfter(step);
    }

    // Preferences persisted, completion still not.
    expect(getSettings().theme).toBe(theme);
    expect(getSettings().density).toBe("compact");
    expect(getSettings().onboardingCompleted).toBe(false);

    // Only the done step's Enter finalizes.
    finalizeOnboarding();
    expect(getSettings().onboardingCompleted).toBe(true);
  });

  it("finalize lands in the global layer and is refused at project scope", () => {
    const home = makeHome();
    configureSettingsStore({ homeDir: home });

    // onboardingCompleted is operator-owned: a project-scoped write is refused.
    expect(updateSetting("onboardingCompleted", true, { scope: "project" })).toBe(false);
    expect(getSettings().onboardingCompleted).toBe(false);

    finalizeOnboarding();
    expect(reloadSettings().onboardingCompleted).toBe(true);
  });
});

describe("onboarding sharing choices", () => {
  it.each(["off", "ask"] as const)("does not broaden an existing %s problem-report preference", (reporting) => {
    configureSettingsStore({ homeDir: makeHome() });
    updateSetting("diagnosticReporting", reporting);
    recordAnalyticsConsent("full");

    const persisted = reloadSettings();
    expect(persisted.diagnosticReporting).toBe(reporting);
    expect(persisted.diagnosticReportingPrompted).toBe(false);
    expect(persisted.onboardingCompleted).toBe(false);
  });

  it("persists a sharing opt-out and disables automatic reports without completing onboarding", () => {
    configureSettingsStore({ homeDir: makeHome() });
    recordAnalyticsConsent("off");

    const persisted = reloadSettings();
    expect(persisted.analyticsLevel).toBe("off");
    expect(persisted.diagnosticReporting).toBe("off");
    expect(persisted.onboardingCompleted).toBe(false);
  });
});

describe("cancel preserves choices without completing", () => {
  it("keeps persisted theme/density and leaves onboardingCompleted false across a reload", () => {
    configureSettingsStore({ homeDir: makeHome() });

    const theme = otherThemeChoice();
    // Preference steps persist on the spot (Enter → updateSetting).
    expect(updateSetting("theme", theme)).toBe(true);
    expect(updateSetting("density", "compact")).toBe(true);

    // Cancel = leave the wizard. finalizeOnboarding is NEVER called on cancel,
    // so nothing writes onboardingCompleted.

    // The next session re-reads disk: choices survive without completing setup.
    const persisted = reloadSettings();
    expect(persisted.theme).toBe(theme);
    expect(persisted.density).toBe("compact");
    expect(persisted.onboardingCompleted).toBe(false);
  });
});
