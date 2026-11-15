import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readUpdateStatus } from "./update-status.js";

function stateWith(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "update-status-"));
  if (content !== undefined) writeFileSync(join(dir, "last-update-check"), content);
  return dir;
}
const cache = (latestVersion: string) => JSON.stringify({ lastCheckedAt: new Date().toISOString(), latestVersion });

describe("readUpdateStatus", () => {
  it("reports a newer cached release with its release-notes URL", () => {
    expect(readUpdateStatus({ current: "0.4.0", policy: "automatic", env: {}, stateDir: stateWith(cache("v0.5.1")) }))
      .toMatchObject({ current: "0.4.0", latest: "0.5.1", available: true, url: "https://github.com/0sec-labs/0security/releases/tag/v0.5.1" });
  });
  it("is not available for equal, older, invalid or prerelease tags", () => {
    for (const tag of ["v0.4.0", "0.3.9", "nonsense", "v0.5.0-rc.1"]) {
      expect(readUpdateStatus({ current: "0.4.0", policy: "notify", env: {}, stateDir: stateWith(cache(tag)) }).available).toBe(false);
    }
  });
  it("reports nothing without a cache or with a corrupt one", () => {
    expect(readUpdateStatus({ current: "0.4.0", policy: "notify", env: {}, stateDir: stateWith() })).toMatchObject({ latest: null, available: false });
    expect(readUpdateStatus({ current: "0.4.0", policy: "notify", env: {}, stateDir: stateWith("{") })).toMatchObject({ latest: null, available: false });
  });
  it("reports nothing when the policy is off or the environment disables checks", () => {
    const stateDir = stateWith(cache("v9.0.0"));
    expect(readUpdateStatus({ current: "0.4.0", policy: "off", env: {}, stateDir })).toMatchObject({ latest: null, available: false });
    expect(readUpdateStatus({ current: "0.4.0", policy: "automatic", env: { ZERO_OFFLINE: "1" }, stateDir }).available).toBe(false);
    expect(readUpdateStatus({ current: "0.4.0", policy: "automatic", env: { ZERO_NO_UPDATE_CHECK: "true" }, stateDir }).available).toBe(false);
  });
  it("offers the in-console update only for a managed binary with a restart path", () => {
    const stateDir = stateWith(cache("v0.5.1"));
    const managed = { kind: "binary" as const, managed: true, dir: "/opt/0" };
    expect(readUpdateStatus({ current: "0.4.0", policy: "automatic", env: {}, stateDir, install: managed, restartable: true })).toMatchObject({ canApply: true, install: { kind: "binary", managed: true } });
    expect(readUpdateStatus({ current: "0.4.0", policy: "automatic", env: {}, stateDir, install: managed })).toMatchObject({ canApply: false });
    for (const kind of ["docker", "npm", "source"] as const) {
      const status = readUpdateStatus({ current: "0.4.0", policy: "automatic", env: {}, stateDir, install: { kind, managed: false, instruction: "x" }, restartable: true });
      expect(status).toMatchObject({ available: true, canApply: false, install: { kind, managed: false, instruction: "x" } });
    }
  });
  it("shows a staged release even when the cache has not caught up", () => {
    expect(readUpdateStatus({ current: "0.4.0", policy: "automatic", env: {}, stateDir: stateWith(), staged: "v0.6.0", phase: "staged", restartable: true, install: { kind: "binary", managed: true, dir: "/x" } }))
      .toMatchObject({ latest: "0.6.0", available: true, phase: "staged", canApply: true });
  });
});
