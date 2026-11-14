import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsPipeline, eventBus } from "@0/engine";

import { DEFAULT_SETTINGS, loadSettings, settingsFilePath, type TuiSettings } from "./settings.js";
import { __resetSettingsStoreForTests, configureSettingsStore, getAnalyticsSetupDraft, getSettings, previewSetting, reloadSettings, setSettings, subscribeSettings, updateSetting } from "./settings-store.js";

/** Temp homes created by a test, torn down after it regardless of outcome. */
const tempHomes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "0-settings-store-"));
  tempHomes.push(dir);
  return dir;
}

/**
 * A home path that is actually a *file*, so `saveSettings`' `mkdirSync` of the
 * `.0` directory underneath it throws (ENOTDIR) and the save reports false —
 * while `loadSettings` still degrades to defaults without throwing.
 */
function makeUnwritableHome(): string {
  const file = join(makeHome(), "not-a-dir");
  writeFileSync(file, "x", "utf8");
  return file;
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

describe("getSettings", () => {
  it("lazily loads a complete, valid object", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const settings = getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("returns a stable reference between reads (no tearing)", () => {
    configureSettingsStore({ homeDir: makeHome() });
    expect(getSettings()).toBe(getSettings());
  });

  it("reads an existing file through loadSettings", () => {
    const home = makeHome();
    configureSettingsStore({ homeDir: home });
    setSettings({ ...DEFAULT_SETTINGS, density: "compact" });
    // A fresh load off disk sees the persisted value.
    expect(loadSettings(home).density).toBe("compact");
  });
});

describe("setSettings / updateSetting", () => {
  it("persists to disk and returns true on success", () => {
    const home = makeHome();
    configureSettingsStore({ homeDir: home });

    const ok = setSettings({ ...DEFAULT_SETTINGS, showSubagents: false });

    expect(ok).toBe(true);
    expect(getSettings().showSubagents).toBe(false);
    expect(loadSettings(home).showSubagents).toBe(false);
  });

  it("updateSetting changes one key and leaves the rest", () => {
    configureSettingsStore({ homeDir: makeHome() });

    const ok = updateSetting("density", "compact");

    expect(ok).toBe(true);
    expect(getSettings().density).toBe("compact");
    expect(getSettings().showSubagents).toBe(DEFAULT_SETTINGS.showSubagents);
  });

  it("normalises an out-of-range value back to a default", () => {
    configureSettingsStore({ homeDir: makeHome() });
    // Force a bogus enum value past the type system, as a hand-edit might.
    updateSetting("density", "chartreuse" as unknown as TuiSettings["density"]);
    expect(getSettings().density).toBe(DEFAULT_SETTINGS.density);
  });

  it("notifies every subscriber synchronously with the new value", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const a = vi.fn();
    const b = vi.fn();
    subscribeSettings(a);
    subscribeSettings(b);

    updateSetting("showTimestamps", true);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]![0].showTimestamps).toBe(true);
    expect(b.mock.calls[0]![0].showTimestamps).toBe(true);
    // The value handed to subscribers is exactly what getSettings now returns.
    expect(a.mock.calls[0]![0]).toBe(getSettings());
  });

  it("does not notify on a plain read", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const fn = vi.fn();
    subscribeSettings(fn);
    getSettings();
    getSettings();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("failed save", () => {
  it("still updates memory and notifies but returns false", () => {
    configureSettingsStore({ homeDir: makeUnwritableHome() });
    const fn = vi.fn();
    subscribeSettings(fn);

    const ok = setSettings({ ...DEFAULT_SETTINGS, density: "compact" });

    expect(ok).toBe(false);
    expect(getSettings().density).toBe("compact");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0].density).toBe("compact");
  });
});

describe("subscriptions", () => {
  it("unsubscribe stops delivery", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const fn = vi.fn();
    const off = subscribeSettings(fn);

    updateSetting("showSubagents", false);
    off();
    updateSetting("showSubagents", true);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a throwing subscriber does not block others or the setter", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const boom = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const after = vi.fn();
    subscribeSettings(boom);
    subscribeSettings(after);

    const ok = setSettings({ ...DEFAULT_SETTINGS, showSubagents: false });

    expect(ok).toBe(true);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe is idempotent", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const fn = vi.fn();
    const off = subscribeSettings(fn);
    off();
    off();
    updateSetting("showSubagents", false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("reloadSettings", () => {
  it("re-reads disk and notifies", () => {
    const home = makeHome();
    configureSettingsStore({ homeDir: home });
    // Persist once so the `.0` directory and file exist on disk.
    setSettings({ ...DEFAULT_SETTINGS, density: "compact" });
    const fn = vi.fn();
    subscribeSettings(fn);

    // An external edit to the file the store is not aware of.
    writeFileSync(
      join(home, ".0", "tui-settings.json"),
      JSON.stringify({ ...DEFAULT_SETTINGS, density: "comfortable" }),
      "utf8",
    );

    const reloaded = reloadSettings();

    expect(reloaded.density).toBe("comfortable");
    expect(getSettings().density).toBe("comfortable");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency", () => {
  it("two rapid updates leave the store consistent and both notify", () => {
    configureSettingsStore({ homeDir: makeHome() });
    const fn = vi.fn();
    subscribeSettings(fn);

    updateSetting("showSubagents", false);
    updateSetting("showCost", false);

    expect(fn).toHaveBeenCalledTimes(2);
    const final = getSettings();
    expect(final.showSubagents).toBe(false);
    expect(final.showCost).toBe(false);
  });
});

// ── Two-level layering in the store ───────────────────────────────────────────

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  loadGlobalSettings,
  projectSettingsFilePath,
  readProjectOverrides,
  saveSettings as saveGlobalSettings,
} from "./settings.js";
import { defaultWriteLayer, getSettingSources } from "./settings-store.js";

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "0-store-project-"));
  tempHomes.push(dir);
  return dir;
}
function writeProjectRaw(projectDir: string, raw: unknown): void {
  const path = projectSettingsFilePath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(raw), "utf8");
}

describe("store: layered reads", () => {
  it("merges project over global with provenance", () => {
    const home = makeHome();
    const project = makeProjectDir();
    saveGlobalSettings({ ...DEFAULT_SETTINGS, showSubagents: false }, home);
    writeProjectRaw(project, { density: "compact" });

    configureSettingsStore({ homeDir: home, projectDir: project });
    expect(getSettings().showSubagents).toBe(false); // global
    expect(getSettings().density).toBe("compact"); // project
    expect(getSettingSources().density).toBe("project");
    expect(getSettingSources().showSubagents).toBe("global");
  });
});

describe("store: write target", () => {
  it("defaults to global when no project override exists", () => {
    const home = makeHome();
    const project = makeProjectDir();
    configureSettingsStore({ homeDir: home, projectDir: project });
    expect(defaultWriteLayer()).toBe("global");

    updateSetting("showSubagents", false);
    // Global file changed; no project file created.
    expect(loadGlobalSettings(home).showSubagents).toBe(false);
    expect(readProjectOverrides(project)).toEqual({});
    expect(getSettingSources().showSubagents).toBe("global");
  });

  it("defaults to the project file once a project override exists", () => {
    const home = makeHome();
    const project = makeProjectDir();
    saveGlobalSettings({ ...DEFAULT_SETTINGS, showTimestamps: true }, home);
    writeProjectRaw(project, { density: "compact" });
    configureSettingsStore({ homeDir: home, projectDir: project });
    expect(defaultWriteLayer()).toBe("project");

    updateSetting("showSubagents", false);
    // The project override grew the key; global is untouched.
    expect(readProjectOverrides(project)).toEqual({ density: "compact", showSubagents: false });
    expect(loadGlobalSettings(home).showSubagents).toBe(DEFAULT_SETTINGS.showSubagents);
    expect(getSettings().showSubagents).toBe(false);
    expect(getSettingSources().showSubagents).toBe("project");
    // Global-only key still falls through.
    expect(getSettings().showTimestamps).toBe(true);
    expect(getSettingSources().showTimestamps).toBe("global");
  });

  it("honours an explicit scope override", () => {
    const home = makeHome();
    const project = makeProjectDir();
    configureSettingsStore({ homeDir: home, projectDir: project });

    updateSetting("density", "compact", { scope: "project" });
    expect(readProjectOverrides(project)).toEqual({ density: "compact" });
    expect(loadGlobalSettings(home).density).toBe(DEFAULT_SETTINGS.density);
  });

  it("persists onboarding globally without promoting or trusting project state", () => {
    const home = makeHome();
    const project = makeProjectDir();
    writeProjectRaw(project, { onboardingCompleted: true, density: "compact" });
    configureSettingsStore({ homeDir: home, projectDir: project });

    expect(getSettings().onboardingCompleted).toBe(false);
    expect(updateSetting("onboardingCompleted", true, { scope: "project" })).toBe(false);
    expect(getSettings().onboardingCompleted).toBe(false);
    expect(updateSetting("onboardingCompleted", true)).toBe(true);
    expect(loadGlobalSettings(home).onboardingCompleted).toBe(true);
    expect(loadGlobalSettings(home).density).toBe(DEFAULT_SETTINGS.density);
    expect(readProjectOverrides(project)).toEqual({ density: "compact" });
    expect(reloadSettings().onboardingCompleted).toBe(true);
    expect(getSettingSources().onboardingCompleted).toBe("global");
    expect(getSettings().density).toBe("compact");
  });

  it("restores the whole model choice globally and rejects a repository account override", () => {
    const home = makeHome();
    const project = makeProjectDir();
    const preference = { providerId: "chatgpt-codex", model: "account-selected-model", connectionIdentity: "a".repeat(64) };
    writeProjectRaw(project, { modelPreference: { ...preference, model: "repository-model" }, density: "compact" });
    configureSettingsStore({ homeDir: home, projectDir: project });
    expect(getSettings().modelPreference).toBeNull();
    expect(updateSetting("modelPreference", preference, { scope: "project" })).toBe(false);
    expect(updateSetting("modelPreference", preference)).toBe(true);
    __resetSettingsStoreForTests();
    configureSettingsStore({ homeDir: home, projectDir: project });
    expect(getSettings().modelPreference).toEqual(preference);
    expect(getSettings().density).toBe("compact");
    expect(loadGlobalSettings(home).density).toBe(DEFAULT_SETTINGS.density);
  });

  it("persists operator consent globally even inside a configured project", () => {
    const home = makeHome();
    const project = makeProjectDir();
    writeProjectRaw(project, { density: "compact" });
    configureSettingsStore({ homeDir: home, projectDir: project });

    expect(updateSetting("diagnosticReporting", "automatic")).toBe(true);
    expect(updateSetting("updatePolicy", "notify")).toBe(true);
    expect(updateSetting("diagnosticReportingPrompted", true)).toBe(true);
    expect(loadGlobalSettings(home).diagnosticReporting).toBe("automatic");
    expect(loadGlobalSettings(home).updatePolicy).toBe("notify");
    expect(loadGlobalSettings(home).diagnosticReportingPrompted).toBe(true);
    expect(readProjectOverrides(project)).toEqual({ density: "compact" });
  });

  it("rejects project consent writes without changing effective policy or notifying", () => {
    const home = makeHome();
    const project = makeProjectDir();
    saveGlobalSettings({ ...DEFAULT_SETTINGS, diagnosticReporting: "off", updatePolicy: "off" }, home);
    writeProjectRaw(project, { density: "compact" });
    configureSettingsStore({ homeDir: home, projectDir: project });
    const before = getSettings();
    const notified = vi.fn();
    subscribeSettings(notified);

    expect(updateSetting("diagnosticReporting", "automatic", { scope: "project" })).toBe(false);
    expect(updateSetting("updatePolicy", "automatic", { scope: "project" })).toBe(false);
    expect(updateSetting("diagnosticReportingPrompted", true, { scope: "project" })).toBe(false);
    expect(getSettings()).toBe(before);
    expect(notified).not.toHaveBeenCalled();
    expect(loadGlobalSettings(home).diagnosticReporting).toBe("off");
    expect(loadGlobalSettings(home).updatePolicy).toBe("off");
    expect(loadGlobalSettings(home).diagnosticReportingPrompted).toBe(false);
    expect(readProjectOverrides(project)).toEqual({ density: "compact" });
  });
});

describe("previewSetting", () => {
  it("updates memory and notifies subscribers WITHOUT persisting to disk", () => {
    const home = makeHome();
    configureSettingsStore({ homeDir: home });
    const original = getSettings().density;
    let notified = 0;
    const unsub = subscribeSettings(() => {
      notified += 1;
    });

    previewSetting("density", "compact");
    expect(getSettings().density).toBe("compact");
    expect(notified).toBe(1);

    // Not durable: a fresh read from disk restores the original value.
    expect(reloadSettings().density).toBe(original);
    unsub();
  });
});

describe("analytics environment restrictions", () => {
  let sent: Record<string, unknown>[];

  beforeEach(() => {
    analyticsPipeline.__resetForTests();
    sent = [];
    for (const name of ["ZERO_ANALYTICS_LEVEL", "ZERO_OFFLINE", "ZERO_NO_TELEMETRY", "DO_NOT_TRACK"]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv("ZERO_CLOUD_HOST", "https://analytics.test");
    vi.stubEnv("ZERO_CLOUD_TOKEN", "test-token");
    analyticsPipeline.configure({
      homeDir: makeHome(),
      fetchImpl: (async (_url, init) => {
        const batch = JSON.parse(String(init?.body)).records;
        sent.push(...batch);
        return new Response(JSON.stringify({ ok: true, accepted: batch.length }), { status: 202 });
      }) as typeof fetch,
    });
  });

  afterEach(() => {
    analyticsPipeline.__resetForTests();
    vi.unstubAllEnvs();
  });

  async function collect(): Promise<void> {
    eventBus.emit("tool_call_started", { tool: "bridge-counter", args_preview: "usage-only fixture", turn: 0, ts: 1 });
    analyticsPipeline.recordCode({ lang: "ts", source: "export const capture = 1;", origin: "bridge-regression" });
    analyticsPipeline.recordScope({ target: "scope-marker", kind: "target" });
    await analyticsPipeline.flushNow();
  }

  it("preserves a shell opt-out across initial settings load and live preference changes", async () => {
    vi.stubEnv("ZERO_ANALYTICS_LEVEL", "off");
    configureSettingsStore({ homeDir: makeHome() });
    expect(getAnalyticsSetupDraft()).toBe("off");
    await collect();
    updateSetting("analyticsLevel", "usage");
    updateSetting("density", "compact");
    await collect();

    expect(process.env["ZERO_ANALYTICS_LEVEL"]).toBe("off");
    expect(sent).toEqual([]);
  });

  it("limits a shell content-sharing grant to usage without forwarding tool content or code", async () => {
    vi.stubEnv("ZERO_ANALYTICS_LEVEL", "commands");
    configureSettingsStore({ homeDir: makeHome() });
    updateSetting("analyticsLevel", "usage");
    await collect();

    expect(sent).toEqual([expect.objectContaining({ kind: "usage", featureCounts: { "bridge-counter": 1 } })]);
    expect(process.env["ZERO_ANALYTICS_LEVEL"]).toBe("commands");
  });

  it("does not broaden a saved opt-out through environment or project settings", async () => {
    const home = makeHome();
    const project = makeProjectDir();
    saveGlobalSettings({ ...DEFAULT_SETTINGS, analyticsLevel: "off" }, home);
    writeProjectRaw(project, { analyticsLevel: "full" });
    vi.stubEnv("ZERO_ANALYTICS_LEVEL", "full");
    configureSettingsStore({ homeDir: home, projectDir: project });
    expect(getAnalyticsSetupDraft()).toBe("off");
    expect(updateSetting("analyticsLevel", "usage", { scope: "project" })).toBe(false);
    await collect();

    expect(sent).toEqual([]);
    expect(loadGlobalSettings(home).analyticsLevel).toBe("off");
  });

  it("enables new-install usage metrics and respects a later saved or shell refusal", async () => {
    const home = makeHome();
    configureSettingsStore({ homeDir: home });
    expect(getAnalyticsSetupDraft()).toBe("usage");
    await collect();
    expect(sent).toEqual([
      expect.objectContaining({ kind: "usage", featureCounts: { "bridge-counter": 1 } }),
    ]);
    expect(loadGlobalSettings(home).analyticsLevel).toBe("usage");
    sent.length = 0;
    updateSetting("analyticsLevel", getAnalyticsSetupDraft());
    await collect();
    expect(sent).toEqual([
      expect.objectContaining({ kind: "usage", featureCounts: { "bridge-counter": 2 } }),
    ]);
    sent.length = 0;
    updateSetting("analyticsLevel", "off");
    await collect();
    expect(sent).toEqual([]);
    updateSetting("analyticsLevel", "usage");
    await collect();
    expect(sent).toEqual([
      expect.objectContaining({ kind: "usage", featureCounts: { "bridge-counter": 1 } }),
    ]);
    sent.length = 0;
    vi.stubEnv("ZERO_ANALYTICS_LEVEL", "off");
    updateSetting("analyticsLevel", "usage");
    expect(getAnalyticsSetupDraft()).toBe("off");
    await collect();
    expect(sent).toEqual([]);
    expect(process.env["ZERO_ANALYTICS_LEVEL"]).toBe("off");
  });

  it("keeps every hard opt-out effective during setup and after a usage confirmation", async () => {
    for (const name of ["ZERO_OFFLINE", "ZERO_NO_TELEMETRY", "DO_NOT_TRACK"]) {
      vi.stubEnv(name, "1");
      configureSettingsStore({ homeDir: makeHome() });
      expect(getAnalyticsSetupDraft()).toBe("off");
      updateSetting("analyticsLevel", "usage");
      await collect();
      expect(sent).toEqual([]);
      vi.stubEnv(name, undefined);
    }
  });

  it("does not propose usage for malformed persisted consent", async () => {
    const home = makeHome();
    mkdirSync(dirname(settingsFilePath(home)), { recursive: true });
    writeFileSync(settingsFilePath(home), JSON.stringify({ analyticsLevel: "invalid" }));
    configureSettingsStore({ homeDir: home });
    expect(getAnalyticsSetupDraft()).toBe("off");
    await collect();
    expect(sent).toEqual([]);
  });
});
