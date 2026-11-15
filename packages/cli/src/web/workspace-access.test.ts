import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFolderError, permissionMessageFor, privacyMessage, probeFolderReadable, protectedFolderName, subjectFromAncestry } from "./workspace-access.js";
import { resolveWorkspaceInput, verifyWorkspaceReadable } from "./workspace-input.js";

const err = (code: string) => Object.assign(new Error(code), { code });
const home = "/Users/ada";

describe("folder error classification", () => {
  it("separates permission, missing, timeout and other failures", () => {
    expect(classifyFolderError(err("EPERM"))).toBe("permission");
    expect(classifyFolderError(err("EACCES"))).toBe("permission");
    expect(classifyFolderError(err("ENOENT"))).toBe("missing");
    expect(classifyFolderError(err("ETIMEDOUT"))).toBe("timeout");
    expect(classifyFolderError(err("EIO"))).toBe("other");
    expect(classifyFolderError(undefined)).toBe("other");
  });
});

describe("protected macOS locations", () => {
  it("names Desktop, Documents, Downloads, iCloud and external drives on macOS only, whatever the case", () => {
    const at = (path: string, platform: NodeJS.Platform = "darwin") => protectedFolderName(path, { platform, home });
    expect(at("/Users/ada/Documents/app")).toBe("Documents");
    expect(at("/users/ada/desktop")).toBe("Desktop");
    expect(at("/Users/ada/Downloads")).toBe("Downloads");
    expect(at("/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/Desktop")).toBe("iCloud Drive");
    expect(at("/Volumes/Backup/work")).toBe("an external or network drive");
    expect(at("/Users/ada/code/app")).toBeNull();
    expect(at("/Users/ada/Documents2")).toBeNull();
    expect(at("/private/var/tmp/x")).toBeNull();
    expect(at("/Users/Shared/x")).toBeNull();
    expect(at("/Users/ada/Documents/app", "linux")).toBeNull();
  });
});

describe("who macOS holds responsible", () => {
  it("names the terminal app, ssh, a background service or falls back", () => {
    expect(subjectFromAncestry(["node", "-zsh", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", "launchd"])).toEqual({ name: "Terminal", kind: "app" });
    expect(subjectFromAncestry(["node", "tmux: server", "/usr/libexec/sshd-session", "/usr/sbin/sshd", "launchd"])).toEqual({ name: "sshd-keygen-wrapper", kind: "ssh" });
    expect(subjectFromAncestry(["node", "/Applications/Claude.app/Contents/MacOS/Claude"])).toEqual({ name: "Claude", kind: "app" });
    expect(subjectFromAncestry(["node", "launchd"]).kind).toBe("service");
    expect(subjectFromAncestry(["node"]).kind).toBe("unknown");
  });
  it("words the guidance in plain steps", () => {
    expect(privacyMessage("Documents", { name: "Terminal", kind: "app" })).toBe("macOS is blocking access to Documents. Allow Terminal under System Settings > Privacy & Security > Files & Folders (or Full Disk Access), then try again.");
    expect(privacyMessage("Documents", { name: "sshd-keygen-wrapper", kind: "ssh" })).toContain("Full Disk Access");
    expect(privacyMessage(null, { name: "node", kind: "unknown" })).toContain("the app that runs 0 (node)");
  });
  it("gives the privacy guidance for EPERM or protected places, ordinary words for EACCES elsewhere", () => {
    const subject = { name: "iTerm2", kind: "app" as const };
    expect(permissionMessageFor("/Users/ada/Desktop/x", { platform: "darwin", home, subject, error: err("EACCES") })).toContain("blocking access to Desktop");
    expect(permissionMessageFor("/opt/x", { platform: "darwin", home, subject, error: err("EPERM") })).toContain("blocking access to that folder");
    expect(permissionMessageFor("/opt/x", { platform: "darwin", home, subject, error: err("EACCES") })).toMatch(/doesn't have permission/);
    expect(permissionMessageFor("/Users/ada/Desktop/x", { platform: "linux", home })).toMatch(/doesn't have permission/);
  });
});

describe("probing like the engine reads", () => {
  it("accepts a readable folder, a slow one, and surfaces EPERM and ENOENT", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zero-probe-"))); mkdirSync(join(root, "a"));
    try {
      expect(await probeFolderReadable(root)).toBe("readable");
      expect(await probeFolderReadable(root, { timeoutMs: 20, open: () => new Promise(() => undefined) })).toBe("slow");
      await expect(probeFolderReadable(root, { open: async () => { throw err("EPERM"); } })).rejects.toMatchObject({ code: "EPERM" });
      await expect(verifyWorkspaceReadable(root, { open: async () => { throw err("EPERM"); } })).rejects.toThrow(/permission|macOS is blocking/);
      await expect(verifyWorkspaceReadable(root, { open: async () => { throw err("ENOENT"); } })).rejects.toThrow(/doesn't exist/);
      await expect(verifyWorkspaceReadable(root, { open: async () => { throw err("EIO"); } })).rejects.toThrow(/couldn't read/);
      await expect(verifyWorkspaceReadable(root, { timeoutMs: 10, open: () => new Promise(() => undefined) })).resolves.toBeUndefined();
      await expect(verifyWorkspaceReadable(root, { open: async () => { throw err("ETIMEDOUT"); } })).resolves.toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("accepts typed paths with trailing slashes and a different case on a case-insensitive volume under one spelling", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zero-case-"))); const dir = join(root, "Docs"); mkdirSync(dir);
    try {
      expect(resolveWorkspaceInput(`${dir}/`, root)).toBe(dir);
      const swapped = join(root, "docs");
      if (process.platform === "darwin") expect(resolveWorkspaceInput(swapped, root)).toBe(dir);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
