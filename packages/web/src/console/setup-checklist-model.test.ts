import { describe, expect, it } from "vitest";
import { canSeeSetupCards, deriveSetupProgress, showSetupCard } from "./setup-checklist-model";
import { normalizeUpdateStatus, showUpdateCard } from "./update-status-model";

const none = { providerConnected: false, modelChosen: false, missionStarted: false, extensionAdded: false };

describe("setup checklist", () => {
  it("stays unknown until every signal is known", () => {
    expect(deriveSetupProgress({})).toBeNull();
    expect(deriveSetupProgress({ ...none, extensionAdded: undefined })).toBeNull();
  });
  it("counts real completions and points at the first incomplete step", () => {
    const progress = deriveSetupProgress({ ...none, providerConnected: true, missionStarted: true })!;
    expect([progress.done, progress.total, progress.complete]).toEqual([2, 4, false]);
    expect(progress.next?.id).toBe("model");
    expect(progress.next?.to).toBe("/models");
  });
  it("completes only when all steps are done", () => {
    const progress = deriveSetupProgress({ providerConnected: true, modelChosen: true, missionStarted: true, extensionAdded: true })!;
    expect(progress.complete).toBe(true);
    expect(progress.next).toBeNull();
    expect(showSetupCard(progress, false)).toBe(false);
  });
  it("hides when dismissed or unknown", () => {
    expect(showSetupCard(deriveSetupProgress(none), false)).toBe(true);
    expect(showSetupCard(deriveSetupProgress(none), true)).toBe(false);
    expect(showSetupCard(null, false)).toBe(false);
  });
  it("gives mission-driven steps a prefilled prompt and settings steps a route", () => {
    const steps = deriveSetupProgress(none)!.steps;
    expect(steps.map(step => Boolean(step.to) !== Boolean(step.prompt))).toEqual([true, true, true, true]);
  });
  it("shows to local users and team owners only", () => {
    expect(canSeeSetupCards({ enabled: false })).toBe(true);
    expect(canSeeSetupCards({ enabled: true, user: { role: "owner" } })).toBe(true);
    expect(canSeeSetupCards({ enabled: true, user: { role: "viewer" } })).toBe(false);
    expect(canSeeSetupCards({ enabled: true, user: { role: "editor" } })).toBe(false);
    expect(canSeeSetupCards({ enabled: true, user: null })).toBe(false);
  });
});

describe("update status", () => {
  const ok = { current: "0.4.0", latest: "0.5.0", available: true, url: "https://github.com/0sec-labs/0/releases/tag/v0.5.0" };
  it("normalizes an available update", () => {
    expect(normalizeUpdateStatus(ok)).toEqual({ current: "0.4.0", latest: "0.5.0", url: ok.url });
  });
  it("rejects unavailable, malformed and foreign-url payloads", () => {
    expect(normalizeUpdateStatus({ ...ok, available: false })).toBeNull();
    expect(normalizeUpdateStatus({ ...ok, latest: "v0.5.0-rc" })).toBeNull();
    expect(normalizeUpdateStatus({ ...ok, url: "javascript:alert(1)" })).toBeNull();
    expect(normalizeUpdateStatus({ ...ok, url: "https://evil.example/releases" })).toBeNull();
    expect(normalizeUpdateStatus(null)).toBeNull();
  });
  it("dismisses per version", () => {
    const status = normalizeUpdateStatus(ok);
    expect(showUpdateCard(status, "")).toBe(true);
    expect(showUpdateCard(status, "0.5.0")).toBe(false);
    expect(showUpdateCard(status, "0.4.9")).toBe(true);
    expect(showUpdateCard(null, "")).toBe(false);
  });
});
