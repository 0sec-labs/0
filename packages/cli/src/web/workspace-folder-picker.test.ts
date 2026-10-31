import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseWorkspaceFolder } from "./workspace-folder-picker.js";
const roots: string[] = [];
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), "zero-native-picker-"))); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("native host folder chooser", () => {
  it("reports unsupported hosts without running a process", async () => {
    const run = vi.fn();
    expect(await chooseWorkspaceFolder(undefined, { platform: "linux", run })).toEqual({ supported: false, path: null });
    expect(run).not.toHaveBeenCalled();
  });
  it("passes literal paths as argv to a fixed bounded executable and canonicalizes the selection", async () => {
    const root = fixture(), initial = join(root, '$(touch nope) "quoted"'), selected = join(root, "selected ");
    mkdirSync(initial); mkdirSync(selected);
    const run = vi.fn(async () => ({ stdout: `${selected}/\n` }));
    expect(await chooseWorkspaceFolder(initial, { platform: "darwin", run })).toEqual({ supported: true, path: selected });
    const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], object];
    expect(file).toBe("/usr/bin/osascript"); expect(args).toHaveLength(3); expect(args[0]).toBe("-e"); expect(args[2]).toBe(initial);
    expect(args[1]).toContain("on run argv"); expect(args[1]).not.toContain(initial); expect(args[1]).not.toMatch(/System Events|Finder|do shell script/);
    expect(options).toEqual({ encoding: "utf8", timeout: 120_000, maxBuffer: 16_384, windowsHide: true });
  });
  it("treats native cancellation as a successful empty selection", async () => {
    expect(await chooseWorkspaceFolder(undefined, { platform: "darwin", run: async () => ({ stdout: "\n" }) })).toEqual({ supported: true, path: null });
  });
  it("rejects concurrent dialogs and releases the mutex after failure", async () => {
    let reject!: (error: Error) => void;
    const first = chooseWorkspaceFolder(undefined, { platform: "darwin", run: () => new Promise((_resolve, fail) => { reject = fail; }) });
    await expect(chooseWorkspaceFolder(undefined, { platform: "darwin", run: vi.fn() })).rejects.toThrow("already open");
    reject(new Error("timeout")); await expect(first).rejects.toThrow("could not complete");
    expect(await chooseWorkspaceFolder(undefined, { platform: "darwin", run: async () => ({ stdout: "" }) })).toEqual({ supported: true, path: null });
  });
  it("rejects malformed paths before process execution and refuses selected files", async () => {
    const run = vi.fn(async () => ({ stdout: "" }));
    for (const input of [null, {}, "a\0b", "x".repeat(4097)]) await expect(chooseWorkspaceFolder(input, { platform: "darwin", run })).rejects.toThrow("valid folder path");
    expect(run).not.toHaveBeenCalled();
    const root = fixture(), file = join(root, "file"); writeFileSync(file, "private");
    await expect(chooseWorkspaceFolder(file, { platform: "darwin", run })).rejects.toThrow("rather than a file");
    await expect(chooseWorkspaceFolder(undefined, { platform: "darwin", run: async () => ({ stdout: `${file}\n` }) })).rejects.toThrow("existing folder");
  });
  it.skipIf(process.platform === "win32")("resolves selected directory symlinks", async () => {
    const root = fixture(), actual = join(root, "actual"), link = join(root, "link"); mkdirSync(actual); symlinkSync(actual, link);
    expect(await chooseWorkspaceFolder(undefined, { platform: "darwin", run: async () => ({ stdout: `${link}/\n` }) })).toEqual({ supported: true, path: actual });
  });
});
