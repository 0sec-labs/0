import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDashboardSidecarInvocation,
  parseDashboardReadyLine,
  sidecarResourceFileName,
} from "./sidecar.js";

const temporaryDirectories: string[] = [];

function makeFixture(): { root: string; assetDir: string } {
  const root = mkdtempSync(join(tmpdir(), "0-desktop-sidecar-"));
  temporaryDirectories.push(root);
  const assetDir = join(root, "dashboard");
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, "index.html"), "<!doctype html>", "utf8");
  return { root, assetDir };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("parseDashboardReadyLine", () => {
  it("accepts only a root loopback HTTP origin", () => {
    expect(parseDashboardReadyLine('ZERO_DASHBOARD_READY {"url":"http://127.0.0.1:48123"}')).toBe(
      "http://127.0.0.1:48123",
    );
    expect(parseDashboardReadyLine('ZERO_DASHBOARD_READY {"url":"http://[::1]:48123"}')).toBe(
      "http://[::1]:48123",
    );
  });

  it.each([
    "unrelated output",
    'ZERO_DASHBOARD_READY {"url":"https://127.0.0.1:48123"}',
    'ZERO_DASHBOARD_READY {"url":"http://localhost:48123"}',
    'ZERO_DASHBOARD_READY {"url":"http://192.0.2.1:48123"}',
    'ZERO_DASHBOARD_READY {"url":"http://user@127.0.0.1:48123"}',
    'ZERO_DASHBOARD_READY {"url":"http://127.0.0.1:48123/dashboard"}',
    'ZERO_DASHBOARD_READY {"url":"http://127.0.0.1:48123?token=leak"}',
    "ZERO_DASHBOARD_READY not-json",
  ])("rejects untrusted readiness line %s", (line) => {
    expect(parseDashboardReadyLine(line)).toBeNull();
  });
});

describe("desktop sidecar invocation", () => {
  it("uses a fixed argv for the development Bun sidecar", () => {
    const { root, assetDir } = makeFixture();
    const cliDirectory = join(root, "packages", "cli", "dist");
    mkdirSync(cliDirectory, { recursive: true });
    writeFileSync(join(cliDirectory, "index.js"), "", "utf8");

    const invocation = createDashboardSidecarInvocation({
      assetDir,
      cwd: root,
      packaged: false,
      projectRoot: root,
      bunPath: "/opt/bun/bin/bun",
    });

    expect(invocation).toEqual({
      command: "/opt/bun/bin/bun",
      args: [
        join(cliDirectory, "index.js"),
        "dashboard",
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--asset-dir",
        assetDir,
        "--ready-json",
      ],
      cwd: root,
    });
  });

  it("requires the platform-matched packaged binary", () => {
    const { root, assetDir } = makeFixture();
    const resourcesPath = join(root, "resources");
    const sidecarDirectory = join(resourcesPath, "sidecars");
    mkdirSync(sidecarDirectory, { recursive: true });
    const executable = join(sidecarDirectory, "0-linux-x64");
    writeFileSync(executable, "", "utf8");

    const invocation = createDashboardSidecarInvocation({
      assetDir,
      cwd: root,
      packaged: true,
      resourcesPath,
      platform: "linux",
      arch: "x64",
    });

    expect(invocation.command).toBe(executable);
    expect(invocation.args).toContain("--ready-json");
  });

  it("maps supported platform artifact names exactly", () => {
    expect(sidecarResourceFileName("linux", "arm64")).toBe("0-linux-arm64");
    expect(sidecarResourceFileName("darwin", "x64")).toBe("0-darwin-x64");
    expect(sidecarResourceFileName("win32", "x64")).toBe("0-windows-x64.exe");
    expect(() => sidecarResourceFileName("freebsd", "x64")).toThrow(/unsupported desktop platform/i);
  });
});
