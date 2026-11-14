import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { assertPrivateStorage, isPrivateWindowsAcl, type WindowsStorageAcl } from "./private-storage.js";
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const user = "S-1-5-21-111-222-333-1001";
const privateAcl = (): WindowsStorageAcl => ({ currentUser: user, owner: user, hasDacl: true, reparsePoint: false, rules: [{ sid: user, allow: true, inheritOnly: false }, { sid: "S-1-5-18", allow: true, inheritOnly: false }, { sid: "S-1-5-32-544", allow: true, inheritOnly: false }] });

describe("platform storage privacy", () => {
  it("accepts native user/SYSTEM/Administrators ACLs including an administrator-owned store", () => {
    expect(isPrivateWindowsAcl(privateAcl())).toBe(true);
    expect(isPrivateWindowsAcl({ ...privateAcl(), owner: "S-1-5-32-544" })).toBe(true);
  });
  it("rejects broad read/write grants, another owner, null DACLs and reparse points", () => {
    for (const sid of ["S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-21-other"]) {
      expect(isPrivateWindowsAcl({ ...privateAcl(), rules: [{ sid, allow: true, inheritOnly: false }] })).toBe(false);
    }
    expect(isPrivateWindowsAcl({ ...privateAcl(), owner: "S-1-5-21-other" })).toBe(false);
    expect(isPrivateWindowsAcl({ ...privateAcl(), hasDacl: false })).toBe(false);
    expect(isPrivateWindowsAcl({ ...privateAcl(), reparsePoint: true })).toBe(false);
  });
  it("allows deny entries but rejects broad inherit-only grants before creating child artifacts", () => {
    expect(isPrivateWindowsAcl({ ...privateAcl(), rules: [{ sid: "S-1-1-0", allow: false, inheritOnly: false }] })).toBe(true);
    expect(isPrivateWindowsAcl({ ...privateAcl(), rules: [{ sid: "S-1-1-0", allow: true, inheritOnly: true }] })).toBe(false);
  });
  it("retains POSIX uid and mode checks without spawning a native ACL probe", () => {
    vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 1000 });
    expect(() => assertPrivateStorage([{ path: "/fixture", stat: { uid: 1000, mode: 0o700 } }])).not.toThrow();
    expect(() => assertPrivateStorage([{ path: "/fixture", stat: { uid: 1000, mode: 0o755 } }])).toThrow("owner-only");
    expect(() => assertPrivateStorage([{ path: "/fixture", stat: { uid: 1001, mode: 0o700 } }])).toThrow("owner-only");
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("checks Windows ACLs in one bounded batch instead of synthetic 077 bits, with no inherited secrets", () => {
    vi.stubGlobal("process", { ...process, platform: "win32", env: { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "fixture-secret", NODE_OPTIONS: "fixture-hook", PSModulePath: "fixture-untrusted" } });
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([privateAcl(), privateAcl()]));
    expect(() => assertPrivateStorage([{ path: "C:\\Users\\fixture\\.0", stat: { uid: 0, mode: 0o777 } }, { path: "C:\\Users\\fixture\\.0\\receipt.json", stat: { uid: 0, mode: 0o666 } }])).not.toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const options = vi.mocked(execFileSync).mock.calls[0]![2] as Record<string, unknown>;
    expect(options.timeout).toBe(5000);
    expect(options).not.toHaveProperty("input");
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    const args = vi.mocked(execFileSync).mock.calls[0]![1] as string[];
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).not.toContain("ReadToEnd");
    expect(script).toContain("$env:ZERO_STORAGE_ACL_PATH_COUNT");
    expect(script).not.toContain("System.Web.Extensions");
    expect(script).not.toMatch(/ConvertFrom-Json|ConvertTo-Json|Get-Acl|Get-Item/);
    expect((options.env as Record<string,string>).ZERO_STORAGE_ACL_PATH_COUNT).toBe("2");
    expect((options.env as Record<string,string>).ZERO_STORAGE_ACL_PATH_0).toBe("C:\\Users\\fixture\\.0");
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    expect((options.env as Record<string,string>).PSModulePath).not.toBe("fixture-untrusted");
  });
  it("keeps the five/ten-second attempt bounds and fails closed on startup timeout without accepting or caching an ACL", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.mocked(execFileSync).mockClear().mockImplementation(() => { throw Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT", stderr: "ACL_STAGE:start" }); });
    const entries = [{ path: "C:\\fixture", stat: { uid: 0, mode: 0o777 } }];
    expect(() => assertPrivateStorage(entries)).toThrow("native stage: start");
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(() => assertPrivateStorage(entries)).toThrow("launch: timeout");
    expect(execFileSync).toHaveBeenCalledTimes(4);
    expect(() => assertPrivateStorage([])).toThrow("batch size");
    expect(() => assertPrivateStorage(Array.from({ length: 65 }, () => entries[0]!))).toThrow("batch size");
    expect(execFileSync).toHaveBeenCalledTimes(4);
  });

  it("retries only a timed-out read-only query and validates the fresh result", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.mocked(execFileSync).mockReset().mockImplementationOnce(() => { throw Object.assign(new Error("timeout secret-path"), { code: "ETIMEDOUT" }); }).mockReturnValueOnce(JSON.stringify([privateAcl()]));
    const entries = [{ path: "fixture", stat: { uid: 0, mode: 0o777 } }];
    expect(() => assertPrivateStorage(entries)).not.toThrow(); expect(execFileSync).toHaveBeenCalledTimes(2);
    const first = vi.mocked(execFileSync).mock.calls[0]!, second = vi.mocked(execFileSync).mock.calls[1]!;
    expect(first.slice(0, 2)).toEqual(second.slice(0, 2));
    expect(first[2]).toEqual({ ...second[2], timeout: 5000 });
    expect(second[2]).toEqual({ ...first[2], timeout: 10000 });
    vi.mocked(execFileSync).mockReset().mockImplementationOnce(() => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); }).mockReturnValueOnce(JSON.stringify([{ ...privateAcl(), hasDacl: false }]));
    expect(() => assertPrivateStorage(entries)).toThrow("native stage: validation"); expect(execFileSync).toHaveBeenCalledTimes(2);
  });
  it.each([["EACCES", "access_denied"], ["EPERM", "access_denied"], ["ENOENT", "not_found"], ["OTHER", "unknown"]])("does not retry %s and exposes only fixed diagnostics", (code, classification) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.mocked(execFileSync).mockReset().mockImplementation(() => { throw { code, stderr: "ACL_STAGE:secretpath private-token", message: "private-token" }; });
    const operation = () => assertPrivateStorage([{ path: "fixture", stat: { uid: 0, mode: 0o777 } }]);
    expect(operation).toThrow(`native stage: startup; launch: ${classification}`); expect(execFileSync).toHaveBeenCalledTimes(1);
    try { operation(); } catch (error) { expect(String(error)).not.toMatch(/secretpath|private-token/); }
  });
  it("classifies a nonzero native exit without retrying", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.mocked(execFileSync).mockReset().mockImplementation(() => { throw { status: 1, stderr: "ACL_STAGE:identity" }; });
    expect(() => assertPrivateStorage([{ path: "fixture", stat: { uid: 0, mode: 0o777 } }])).toThrow("native stage: identity; launch: native_exit");
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("fails closed when native ACL inspection fails or returns malformed data", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("fixture-probe-failure"); });
    expect(() => assertPrivateStorage([{ path: "fixture", stat: { uid: 0, mode: 0o777 } }])).toThrow("Unable to verify");
    vi.mocked(execFileSync).mockReturnValue("{}");
    expect(() => assertPrivateStorage([{ path: "fixture", stat: { uid: 0, mode: 0o777 } }])).toThrow("Unable to verify");
  });
});
