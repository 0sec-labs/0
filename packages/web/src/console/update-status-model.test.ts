import { describe, expect, it } from "vitest";
import {
  currentVersionOf, normalizeUpdateStatus, parsePendingUpdate, updateCardView, updateCommandFor, updateFinished,
  type InstallKind, type UpdateCardUi, type UpdateStatus,
} from "./update-status-model";

const url = "https://github.com/0sec-labs/0security/releases/tag/v0.33.0";
const raw = (over: Record<string, unknown> = {}) => ({ current: "0.31.0", latest: "0.33.0", available: true, url, install: { kind: "binary", managed: true }, canApply: true, phase: "idle", threadsRunning: 0, supervised: false, serverMode: false, ...over });
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...normalizeUpdateStatus(raw())!, ...over });
const idle: UpdateCardUi = { confirmThreads: null, working: null };

describe("normalizeUpdateStatus", () => {
  it("ignores answers with no newer release, a bad version or a foreign URL", () => {
    expect(normalizeUpdateStatus({ ...raw(), available: false })).toBeNull();
    expect(normalizeUpdateStatus(raw({ latest: "v0.33" }))).toBeNull();
    expect(normalizeUpdateStatus(raw({ url: "https://evil.example/releases" }))).toBeNull();
    expect(normalizeUpdateStatus(null)).toBeNull();
  });
  it("treats an older server (no install field) as one that cannot update itself", () => {
    expect(normalizeUpdateStatus({ current: "0.31.0", latest: "0.33.0", available: true, url })).toMatchObject({ canApply: false, install: { kind: "binary", managed: false } });
  });
  it("never lets canApply stand for an unmanaged install", () => {
    for (const kind of ["docker", "npm", "source"]) expect(normalizeUpdateStatus(raw({ install: { kind, managed: true }, canApply: true }))?.canApply).toBe(false);
    expect(normalizeUpdateStatus(raw({ install: { kind: "binary", managed: false }, canApply: true }))?.canApply).toBe(false);
  });
});

describe("updateCardView", () => {
  it("managed binary: a primary Update and restart button with the corrected wording", () => {
    const view = updateCardView(status(), idle);
    expect(view.title).toBe("Update available · 0.33.0");
    expect(view.detail).toBe("You have 0.31.0");
    expect(view.action).toEqual({ kind: "apply", label: "Update and restart" });
  });
  it("shows progress while installing and restarting, with no second click possible", () => {
    expect(updateCardView(status(), { confirmThreads: null, working: "updating" }).action).toEqual({ kind: "busy", label: "Updating…" });
    expect(updateCardView(status(), { confirmThreads: null, working: "restarting" }).action).toEqual({ kind: "busy", label: "Restarting…" });
    expect(updateCardView(status({ phase: "installing" }), idle).action).toMatchObject({ kind: "busy", label: "Updating…" });
    expect(updateCardView(status({ phase: "restarting" }), idle).action).toMatchObject({ kind: "busy", label: "Restarting…" });
  });
  it("staged: one click to restart into the installed version", () => {
    const view = updateCardView(status({ phase: "staged" }), idle);
    expect(view.title).toBe("Ready to restart · 0.33.0");
    expect(view.action).toEqual({ kind: "apply", label: "Restart to finish updating" });
  });
  it("asks before interrupting running threads", () => {
    expect(updateCardView(status(), { confirmThreads: 2, working: null }).action).toEqual({ kind: "confirm", message: "2 threads are running.", wait: "Update after they finish", anyway: "Update anyway" });
    expect(updateCardView(status(), { confirmThreads: 1, working: null }).action).toMatchObject({ message: "1 thread is running." });
  });
  it("offers no button that cannot work: Docker, source, npm and read-only installs only get the right instruction", () => {
    const expected: Record<InstallKind, string> = {
      docker: "docker pull ghcr.io/0sec-labs/0security:latest",
      source: "git pull",
      npm: "npm uninstall -g 0sec-cli && curl -fsSL https://raw.githubusercontent.com/0sec-labs/0security/main/install.sh | bash",
      binary: "0 config doctor upgrade",
    };
    for (const kind of Object.keys(expected) as InstallKind[]) {
      const view = updateCardView(status({ canApply: false, install: { kind, managed: false } }), idle);
      expect(view.action).toMatchObject({ kind: "copy", label: "Copy update command", command: expected[kind] });
      expect(updateCommandFor(kind)).toBe(expected[kind]);
    }
    expect(updateCardView(status({ canApply: false, install: { kind: "docker", managed: false } }), idle).action).toMatchObject({ note: expect.stringContaining("recreate the container") });
  });
  it("surfaces a failed update next to the button so it can be retried", () => {
    expect(updateCardView(status(), { ...idle, failure: "checksum mismatch" })).toMatchObject({ failure: "checksum mismatch", action: { kind: "apply" } });
  });
});

describe("restart tracking", () => {
  it("remembers a pending update briefly, and only a well-formed one", () => {
    const now = 1_000_000;
    expect(parsePendingUpdate(JSON.stringify({ version: "0.33.0", startedAt: now - 1000, supervised: true }), now)).toEqual({ version: "0.33.0", startedAt: now - 1000, supervised: true });
    expect(parsePendingUpdate(JSON.stringify({ version: "0.33.0", startedAt: now - 10 * 60_000 }), now)).toBeNull();
    expect(parsePendingUpdate("nope", now)).toBeNull();
    expect(parsePendingUpdate(null, now)).toBeNull();
  });
  it("is finished once the server reports the requested version or newer, never before", () => {
    const pending = { version: "0.33.0", startedAt: 0, supervised: false };
    expect(updateFinished(pending, null)).toBe(false);
    expect(updateFinished(pending, "0.31.0")).toBe(false);
    expect(updateFinished(pending, "0.33.0")).toBe(true);
    expect(updateFinished(pending, "0.34.1")).toBe(true);
    expect(currentVersionOf({ current: "0.33.0", available: false })).toBe("0.33.0");
    expect(currentVersionOf({})).toBeNull();
  });
});
