import { describe, expect, it } from "vitest";
import { canSeeSetupCards, deriveSetupProgress, showSetupCard } from "./setup-checklist-model";
import { normalizeUpdateStatus, showUpdateCard } from "./update-status-model";

const none = { providerConnected: false, missionStarted: false };

describe("setup checklist", () => {
  it("stays unknown until every signal is known", () => {
    expect(deriveSetupProgress({})).toBeNull();
    expect(deriveSetupProgress({ providerConnected: true })).toBeNull();
  });
  it("counts real completions and points at the first incomplete step", () => {
    const progress = deriveSetupProgress({ providerConnected: true, missionStarted: false })!;
    expect([progress.done, progress.total, progress.complete]).toEqual([1, 2, false]);
    expect(progress.next?.id).toBe("mission");
    expect(deriveSetupProgress(none)!.next?.to).toBe("/connections");
  });
  it("completes only when all steps are done", () => {
    const progress = deriveSetupProgress({ providerConnected: true, missionStarted: true })!;
    expect(progress.complete).toBe(true);
    expect(progress.next).toBeNull();
    expect(showSetupCard(progress, false)).toBe(false);
  });
  it("hides when dismissed or unknown", () => {
    expect(showSetupCard(deriveSetupProgress(none), false)).toBe(true);
    expect(showSetupCard(deriveSetupProgress(none), true)).toBe(false);
    expect(showSetupCard(null, false)).toBe(false);
  });
  it("sends the provider step to Connections and the mission step to a prefilled prompt", () => {
    const steps = deriveSetupProgress(none)!.steps;
    expect(steps.map(step => Boolean(step.to) !== Boolean(step.prompt))).toEqual([true, true]);
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
