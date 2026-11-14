import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  execSync: vi.fn(),
}));
const { installPackageForEcosystem } = await import("./package-ecosystems.js");

describe("package target option injection", () => {
  beforeEach(() => { execFileSyncMock.mockReset(); execFileSyncMock.mockImplementation(() => { throw new Error("package manager invoked"); }); });
  it.each(["npm", "pypi", "cargo", "oci"] as const)("never passes a dash-prefixed %s package name to the package manager", ecosystem => {
    for (const name of ["--registry=http://127.0.0.1:1/", "-g", "--userconfig=/tmp/x", "--index-url=http://127.0.0.1:1/simple"]) {
      expect(() => installPackageForEcosystem(ecosystem, name, undefined, () => undefined)).toThrow(/Invalid package/);
    }
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
