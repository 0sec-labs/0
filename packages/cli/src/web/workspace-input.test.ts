import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeWorkspaceInput, resolveWorkspaceInput } from "./workspace-input.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-input-")));
const spaced = join(root, "my proj"); const unicode = join(root, "ünï"); const link = join(root, "link"); const file = join(root, "a.txt");
mkdirSync(spaced); mkdirSync(unicode); symlinkSync(spaced, link); writeFileSync(file, "x");

describe("workspace input", () => {
  it("expands ~, quotes and file URLs", () => {
    expect(normalizeWorkspaceInput("~", "/h")).toBe("/h");
    expect(normalizeWorkspaceInput("~/p q", "/h")).toBe("/h/p q");
    expect(normalizeWorkspaceInput(`"${spaced}"`)).toBe(spaced);
    expect(normalizeWorkspaceInput("file:///a%20b")).toBe("/a b");
  });
  it("accepts spaces, unicode, symlinks and trailing slashes repeatedly (A to B to A)", () => {
    for (const [input, want] of [[spaced + "/", spaced], [unicode, unicode], [link + "/", spaced], [spaced, spaced]] as const) expect(resolveWorkspaceInput(input, root)).toBe(want);
  });
  it("resolves relative paths against the current folder", () => expect(resolveWorkspaceInput("ünï", root)).toBe(unicode));
  it("gives distinct plain messages", () => {
    expect(() => resolveWorkspaceInput(join(root, "nope"), root)).toThrow(/doesn't exist/);
    expect(() => resolveWorkspaceInput(file, root)).toThrow(/is a file/);
    expect(() => resolveWorkspaceInput("~", root)).toThrow(/whole home folder/);
    expect(() => resolveWorkspaceInput("/", root)).toThrow(/whole home folder/);
    expect(() => resolveWorkspaceInput("  ", root)).toThrow(/Enter a folder/);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects a folder Zero cannot read", () => {
    const locked = join(root, "locked"); mkdirSync(locked); chmodSync(locked, 0o000);
    try { expect(() => resolveWorkspaceInput(locked, root)).toThrow(/doesn.t have permission/); }
    finally { chmodSync(locked, 0o700); }
  });
});
