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
      .toEqual({ current: "0.4.0", latest: "0.5.1", available: true, url: "https://github.com/0sec-labs/0/releases/tag/v0.5.1" });
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
});
