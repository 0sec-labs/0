/**
 * Guided onboarding — the step machine and its two load-bearing invariants.
 *
 * These assertions exercise the machine and its persistence contract WITHOUT
 * rendering the dialog (there is no OpenTUI test renderer in this suite): the
 * step order and transitions are pure exports, and completion/cancel are
 * verified through the real settings store pointed at a temp home, exactly the
 * way `settings-store.test.ts` drives it. The single completion writer
 * (`finalizeOnboarding`) and every preference write go through the same
 * `updateSetting` the live component calls, so what passes here is what the
 * component's handlers do.
 *
 * NOTE ON DISCOVERY: `vitest.config.ts` restricts `include` to
 * `src/**\/*.test.ts`, so this `.test.tsx` file is not auto-collected by a
 * plain `vitest run`. Widen the include to `src/**\/*.test.{ts,tsx}` (or run
 * this file by path) to execute it. It is authored per the task's file list.
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
  ONBOARDING_PREFERENCE_KEYS,
  ONBOARDING_STEPS,
  finalizeOnboarding,
  recordAnalyticsConsent,
  skipAnalyticsConsent,
  stepAfter,
  type OnboardingStep,
} from "./onboarding-screen.js";

const tempHomes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "0sec-onboarding-"));
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
  it("walks welcome → connect → models → preferences → analytics → done", () => {
    expect(ONBOARDING_STEPS.map((s) => s.key)).toEqual([
      "welcome",
      "connect",
      "models",
      "preferences",
      "analytics",
      "done",
    ]);
    expect(ONBOARDING_STEPS.map((s) => s.label)).toEqual([
      "Welcome",
      "Connect",
      "Models",
      "Preferences",
      "Analytics",
      "Done",
    ]);

    // Analytics is skippable; only welcome and done are not.
    const analytics = ONBOARDING_STEPS.find((s) => s.key === "analytics");
    expect(analytics?.skippable).toBe(true);

    // Linear transitions — the same chain the embedded ConnectScreen.onConnected
    // and ModelScreen.onSelect advance along. Analytics sits between the
    // preferences step and completion.
    expect(stepAfter("welcome")).toBe("connect");
    expect(stepAfter("connect")).toBe("models");
    expect(stepAfter("models")).toBe("preferences");
    expect(stepAfter("preferences")).toBe("analytics");
    expect(stepAfter("analytics")).toBe("done");
    expect(stepAfter("done")).toBeUndefined();
  });

  it("never mounts the full Settings catalogue — preferences are two safe Display cosmetics", () => {
    expect(ONBOARDING_PREFERENCE_KEYS).toEqual(["theme", "density"]);
    for (const key of ONBOARDING_PREFERENCE_KEYS) {
      const def = SETTING_DEFS.find((d) => d.key === key);
      expect(def, `SETTING_DEFS must define ${key}`).toBeDefined();
      expect(def?.kind).toBe("enum");
      expect(def?.group).toBe("Display");
      expect((def?.choices?.length ?? 0)).toBeGreaterThan(1);
    }
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

describe("analytics consent wiring", () => {
  it("a sharing tier sets analyticsLevel, derives diagnosticReporting automatic, and marks prompted", () => {
    configureSettingsStore({ homeDir: makeHome() });
    // Start from a non-default reporting value so the write is observable.
    expect(updateSetting("diagnosticReporting", "off")).toBe(true);
    expect(getSettings().analyticsLevel).toBe("off");
    expect(getSettings().diagnosticReportingPrompted).toBe(false);

    recordAnalyticsConsent("usage");

    expect(getSettings().analyticsLevel).toBe("usage");
    // diagnosticReporting is DERIVED: any tier above "off" is "automatic".
    expect(getSettings().diagnosticReporting).toBe("automatic");
    expect(getSettings().diagnosticReportingPrompted).toBe(true);
    // Consent is independent of completion.
    expect(getSettings().onboardingCompleted).toBe(false);
  });

  it("maps each sharing tier to analyticsLevel and keeps diagnosticReporting in sync", () => {
    for (const level of ["usage", "commands", "full"] as const) {
      configureSettingsStore({ homeDir: makeHome() });
      recordAnalyticsConsent(level);
      expect(getSettings().analyticsLevel).toBe(level);
      // Every sharing tier derives reporting on.
      expect(getSettings().diagnosticReporting).toBe("automatic");
      expect(getSettings().diagnosticReportingPrompted).toBe(true);
    }
  });

  it("the decline tier sets analyticsLevel off, derives diagnosticReporting off, and marks prompted", () => {
    configureSettingsStore({ homeDir: makeHome() });
    // Default reporting is "automatic"; declining must turn it fully off.
    expect(getSettings().diagnosticReporting).toBe("automatic");

    recordAnalyticsConsent("off");

    expect(getSettings().analyticsLevel).toBe("off");
    expect(getSettings().diagnosticReporting).toBe("off");
    expect(getSettings().diagnosticReportingPrompted).toBe(true);
    expect(getSettings().onboardingCompleted).toBe(false);
  });

  it("skip marks prompted but leaves the current level and reporting default unchanged", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const beforeReporting = getSettings().diagnosticReporting;
    const beforeLevel = getSettings().analyticsLevel;
    expect(getSettings().diagnosticReportingPrompted).toBe(false);

    skipAnalyticsConsent();

    // Prompted is recorded so the in-session prompt never re-asks…
    expect(getSettings().diagnosticReportingPrompted).toBe(true);
    // …but neither the level nor the reporting value is touched by a skip.
    expect(getSettings().analyticsLevel).toBe(beforeLevel);
    expect(getSettings().diagnosticReporting).toBe(beforeReporting);
    expect(getSettings().onboardingCompleted).toBe(false);
  });

  it("consent decisions survive a reload without completing onboarding", () => {
    configureSettingsStore({ homeDir: makeHome() });
    recordAnalyticsConsent("off");

    const persisted = reloadSettings();
    expect(persisted.analyticsLevel).toBe("off");
    expect(persisted.diagnosticReporting).toBe("off");
    expect(persisted.diagnosticReportingPrompted).toBe(true);
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

    // The next session re-reads disk: choices survive, onboarding shows again.
    const persisted = reloadSettings();
    expect(persisted.theme).toBe(theme);
    expect(persisted.density).toBe("compact");
    expect(persisted.onboardingCompleted).toBe(false);
  });
});
