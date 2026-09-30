/** Onboarding state and consent contracts. Rendered navigation
 * coverage lives in test/tui-driver/scenarios/onboarding-navigation.tui.test.ts.
 * Native mascot contracts live in test/tui-driver/scenarios/mascot.tui.test.ts.
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
  it("ends at the final data-sharing decision", () => {
    expect(stepAfter("welcome")).toBe("connect");
    expect(stepAfter("connect")).toBe("models");
    expect(stepAfter("models")).toBe("preferences");
    expect(stepAfter("preferences")).toBe("analytics");
    expect(stepAfter("analytics")).toBeUndefined();
  });

  it("can revisit every previous decision", () => {
    expect(stepBefore("welcome")).toBeUndefined();
    expect(stepBefore("connect")).toBe("welcome");
    expect(stepBefore("models")).toBe("connect");
    expect(stepBefore("preferences")).toBe("models");
    expect(stepBefore("analytics")).toBe("preferences");
  });

});

describe("completion is written in exactly one place", () => {
  it("theme and sharing writes do not complete setup on their own", () => {
    configureSettingsStore({ homeDir: makeHome() });
    expect(getSettings().onboardingCompleted).toBe(false);

    // Reaching and saving each decision does not complete setup until the final UI action.
    let step: OnboardingStep | undefined = "welcome";
    const theme = otherThemeChoice();
    while (step) {
      if (step === "preferences") {
        expect(updateSetting("theme", theme)).toBe(true);
      }
      if (step === "analytics") recordAnalyticsConsent("usage");
      expect(getSettings().onboardingCompleted).toBe(false);
      step = stepAfter(step);
    }

    // Preferences persisted, completion still not.
    expect(getSettings().theme).toBe(theme);
    expect(getSettings().density).toBe("comfortable");
    expect(getSettings().onboardingCompleted).toBe(false);

    // The final confirmation writes the single operator-owned completion setting.
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
  it.each(["off", "ask"] as const)("keeps existing %s Sentry consent separate from usage analytics", (reporting) => {
    configureSettingsStore({ homeDir: makeHome() });
    updateSetting("diagnosticReporting", reporting);
    recordAnalyticsConsent("usage");

    const persisted = reloadSettings();
    expect(persisted.analyticsLevel).toBe("usage");
    expect(persisted.diagnosticReporting).toBe(reporting);
    expect(persisted.diagnosticReportingPrompted).toBe(false);
    expect(persisted.onboardingCompleted).toBe(false);
  });

  it("persists an analytics opt-out without changing independent Sentry consent", () => {
    configureSettingsStore({ homeDir: makeHome() });
    updateSetting("diagnosticReporting", "automatic");
    recordAnalyticsConsent("off");

    const persisted = reloadSettings();
    expect(persisted.analyticsLevel).toBe("off");
    expect(persisted.diagnosticReporting).toBe("automatic");
    expect(persisted.diagnosticReportingPrompted).toBe(false);
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
