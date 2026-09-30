import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbenchConfig, resolveWorkbenchGuestSettings, saveWorkbenchConfig, normalizeWorkbenchConfig, workbenchConfigPath, workbenchNetworkEnabled } from "./workbench.js";
import type { WorkbenchConfig } from "./workbench.js";
import { DEFAULT_SETTINGS } from "./tui/settings.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "0-workbench-grants-"));
  homes.push(home);
  return home;
}

describe("workbench authority boundary", () => {
  it("rejects unsupported credential forwarding instead of exposing host secrets", () => {
    const choices = { schemaVersion: 1, image: "/approved.tar", imageDigest: "sha256:" + "a".repeat(64), stateRoot: "/private/workbench", providers: ["chatgpt-codex"], github: false, cpus: 2, memoryMb: 2048, storageGb: 4 };
    expect(normalizeWorkbenchConfig(choices).providers).toEqual(["chatgpt-codex"]);
    expect(() => normalizeWorkbenchConfig({ ...choices, github: true })).toThrow("GitHub credential forwarding");
    expect(() => normalizeWorkbenchConfig({ ...choices, providers: ["openai"] })).toThrow("only host-brokered");
  });

  it("never broadens saved consent and keeps privacy opt-outs separate from VM network policy", () => {
    const optedIn = { ...DEFAULT_SETTINGS, analyticsLevel: "usage" as const, diagnosticReporting: "automatic" as const };
    const limited = resolveWorkbenchGuestSettings(optedIn, { ZERO_ANALYTICS_LEVEL: "usage" });
    expect(limited.analyticsLevel).toBe("usage");
    expect(limited.diagnosticReporting).toBe("automatic");
    const optedOut = resolveWorkbenchGuestSettings(optedIn, { DO_NOT_TRACK: "true" });
    expect(optedOut.analyticsLevel).toBe("off");
    expect(optedOut.diagnosticReporting).toBe("off");
    expect(workbenchNetworkEnabled({ DO_NOT_TRACK: "true" })).toBe(true);
    const offline = resolveWorkbenchGuestSettings(optedIn, { ZERO_OFFLINE: "true" });
    expect(offline.analyticsLevel).toBe("off");
    expect(offline.diagnosticReporting).toBe("off");
    expect(workbenchNetworkEnabled({ ZERO_OFFLINE: "true" })).toBe(false);
    expect(workbenchNetworkEnabled({ ZERO_OFFLINE: "false" })).toBe(true);
    const savedRefusal = resolveWorkbenchGuestSettings({ ...DEFAULT_SETTINGS, analyticsLevel: "off", diagnosticReporting: "off" }, { ZERO_ANALYTICS_LEVEL: "full" });
    expect(savedRefusal.analyticsLevel).toBe("off");
    expect(savedRefusal.diagnosticReporting).toBe("off");
  });


  it("stores only validated operator choices privately and refuses unreadable authority instead of resetting it", () => {
    const home = temporaryHome();
    const config: WorkbenchConfig = { schemaVersion: 1, image: "/approved/image.tar", imageDigest: `sha256:${"a".repeat(64)}`, stateRoot: join(home, ".0", "workbench"), providers: ["chatgpt-codex"], github: false, cpus: 2, memoryMb: 4096, storageGb: 20, approvedImages: [{ reference: `registry.example:443/security/toolbox@sha256:${"b".repeat(64)}`, archive: "/approved/toolbox.tar", digest: `sha256:${"c".repeat(64)}` }] };
    saveWorkbenchConfig(config, home);
    expect(loadWorkbenchConfig(home)).toEqual(config);
    expect(() => saveWorkbenchConfig({ ...config, approvedImages: [{ ...config.approvedImages![0]!, reference: "alpine:latest" }] }, home)).toThrow();
    expect(() => saveWorkbenchConfig({ ...config, approvedImages: [...config.approvedImages!, ...config.approvedImages!] }, home)).toThrow();
    expect(statSync(workbenchConfigPath(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(workbenchConfigPath(home), "utf8")).not.toContain("selected-account");
    chmodSync(workbenchConfigPath(home), 0o644);
    expect(() => loadWorkbenchConfig(home)).toThrow();
    chmodSync(workbenchConfigPath(home), 0o600);
    writeFileSync(workbenchConfigPath(home), "{broken");
    expect(() => loadWorkbenchConfig(home)).toThrow();
  });
});
