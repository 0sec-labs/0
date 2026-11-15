import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseWorkspaceFolder, type PickerProcess } from "./workspace-folder-picker.js";
const roots: string[] = [];
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), "zero-native-picker-"))); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { try { chmodSync(root, 0o700); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); } });
const ok = (stdout: string): PickerProcess => ({ stdout, stderr: "", code: 0, timedOut: false, aborted: false });
const failure = (stderr: string, extra: Partial<PickerProcess> = {}): PickerProcess => ({ stdout: "", stderr, code: 1, timedOut: false, aborted: false, ...extra });
const base = { platform: "darwin" as const, interactive: () => true, subject: { name: "Terminal", kind: "app" as const } };

describe("native host folder chooser", () => {
  it("reports unsupported hosts without running a process", async () => {
    const run = vi.fn();
    expect(await chooseWorkspaceFolder(undefined, { platform: "linux", run })).toEqual({ supported: false, path: null });
    expect(run).not.toHaveBeenCalled();
  });
  it("does not offer the chooser to a browser on another computer or to a host without a desktop session", async () => {
    const run = vi.fn();
    expect(await chooseWorkspaceFolder(undefined, { ...base, local: false, run })).toMatchObject({ supported: false, path: null, message: expect.stringContaining("not on this one") });
    expect(await chooseWorkspaceFolder(undefined, { ...base, interactive: () => false, run })).toMatchObject({ supported: false, message: expect.stringContaining("without a desktop session") });
    expect(run).not.toHaveBeenCalled();
  });
  it("passes literal paths as argv to a fixed bounded executable and canonicalizes the selection", async () => {
    const root = fixture(), initial = join(root, '$(touch nope) "quoted"'), selected = join(root, "selected ");
    mkdirSync(initial); mkdirSync(selected);
    const run = vi.fn(async () => ok(`${selected}/\n`));
    expect(await chooseWorkspaceFolder(initial, { ...base, run })).toEqual({ supported: true, path: selected });
    const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], object];
    expect(file).toBe("/usr/bin/osascript"); expect(args).toHaveLength(3); expect(args[0]).toBe("-e"); expect(args[2]).toBe(initial);
    expect(args[1]).toContain("on run argv"); expect(args[1]).not.toContain(initial); expect(args[1]).not.toMatch(/System Events|Finder|do shell script/);
    expect(options).toEqual({ timeoutMs: 120_000 });
  });
  it("treats only native cancellation (-128 or an empty answer) as silent", async () => {
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: async () => ok("\n") })).toEqual({ supported: true, path: null });
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: async () => failure("execution error: User canceled. (-128)") })).toEqual({ supported: true, path: null });
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: async () => ok("") , signal: AbortSignal.abort() })).toEqual({ supported: true, path: null });
  });
  it("shows macOS automation denial (-1743) and other failures instead of treating them as cancel", async () => {
    const denied = await chooseWorkspaceFolder(undefined, { ...base, run: async () => failure("execution error: Not authorized to send Apple events to System Events. (-1743)") });
    expect(denied).toMatchObject({ supported: true, path: null, privacy: true, message: expect.stringContaining("Automation") });
    expect(denied.message).toContain("Terminal");
    const eperm = await chooseWorkspaceFolder(undefined, { ...base, run: async () => failure("open: Operation not permitted") });
    expect(eperm).toMatchObject({ privacy: true, message: expect.stringContaining("macOS is blocking access to") });
    const other = await chooseWorkspaceFolder(undefined, { ...base, run: async () => failure("syntax error (-2741)") });
    expect(other.message).toContain("could not complete"); expect(other.privacy).toBeUndefined();
    expect(JSON.stringify(other)).not.toContain("-2741");
    expect((await chooseWorkspaceFolder(undefined, { ...base, run: async () => failure("", { timedOut: true }) })).message).toContain("two minutes");
  });
  it("releases the mutex after any outcome and answers a concurrent request plainly", async () => {
    let finish!: (value: PickerProcess) => void;
    const first = chooseWorkspaceFolder(undefined, { ...base, run: () => new Promise((resolve) => { finish = resolve; }) });
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: vi.fn() })).toMatchObject({ message: expect.stringContaining("already open") });
    finish(failure("boom")); expect((await first).message).toContain("could not complete");
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: async () => ok("") })).toEqual({ supported: true, path: null });
    await expect(chooseWorkspaceFolder(undefined, { ...base, run: async () => { throw new Error("spawn failed"); } })).rejects.toThrow("spawn failed");
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: async () => ok("") })).toEqual({ supported: true, path: null });
  });
  it("rejects malformed paths before process execution and refuses selected files", async () => {
    const run = vi.fn(async () => ok(""));
    for (const input of [null, {}, "a\0b", "x".repeat(4097)]) await expect(chooseWorkspaceFolder(input, { ...base, run })).rejects.toThrow("valid folder path");
    expect(run).not.toHaveBeenCalled();
    const root = fixture(), file = join(root, "file"); writeFileSync(file, "private");
    // A file as the starting point only opens the chooser at its default place.
    await expect(chooseWorkspaceFolder(file, { ...base, run })).resolves.toEqual({ supported: true, path: null });
    expect(run).toHaveBeenCalledWith("/usr/bin/osascript", expect.not.arrayContaining([file]), expect.anything());
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: async () => ok(`${file}\n`) })).toMatchObject({ path: null, message: expect.stringContaining("existing folder") });
  });
  it.skipIf(process.platform === "win32")("resolves selected directory symlinks", async () => {
    const root = fixture(), actual = join(root, "actual"), link = join(root, "link"); mkdirSync(actual); symlinkSync(actual, link);
    expect(await chooseWorkspaceFolder(undefined, { ...base, run: async () => ok(`${link}/\n`) })).toEqual({ supported: true, path: actual });
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not accept a chosen folder the host cannot read", async () => {
    const root = fixture(), locked = join(root, "locked"); mkdirSync(locked); chmodSync(locked, 0o000);
    try {
      const result = await chooseWorkspaceFolder(undefined, { ...base, run: async () => ok(`${locked}/\n`) });
      expect(result.path).toBeNull(); expect(result.message).toMatch(/permission|macOS is blocking/);
    } finally { chmodSync(locked, 0o700); }
  });
  it.skipIf(process.platform === "win32")("runs a stub osascript end to end and kills it when the request is aborted", async () => {
    const root = fixture(), stub = join(root, "osascript"), target = join(root, "chosen"); mkdirSync(target);
    writeFileSync(stub, `#!/bin/sh\nif [ -n "$STUB_HANG" ]; then sleep 30; fi\nprintf '%s\\n' "${target}/"\n`, { mode: 0o755 });
    expect(await chooseWorkspaceFolder(undefined, { ...base, command: stub })).toEqual({ supported: true, path: target });
    const hang = join(root, "hang"); writeFileSync(hang, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = chooseWorkspaceFolder(undefined, { ...base, command: hang, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toEqual({ supported: true, path: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    const failing = join(root, "fail"); writeFileSync(failing, "#!/bin/sh\necho 'execution error: User canceled. (-128)' >&2\nexit 1\n", { mode: 0o755 });
    expect(await chooseWorkspaceFolder(undefined, { ...base, command: failing })).toEqual({ supported: true, path: null });
    const slow = chooseWorkspaceFolder(undefined, { ...base, command: hang, timeoutMs: 200 });
    expect((await slow).message).toContain("two minutes");
  });
});
