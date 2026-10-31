import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { NativeRuntime } from "../runtime/types.js";

const io = vi.hoisted(() => ({
  root: "", active: 0, peak: 0, bytesRead: 0, gated: new Set<number | string>(), started: [] as string[], descriptors: new Map<number, string>(),
  releases: [] as Array<() => void>, finished: [] as Array<Promise<void>>,
  ready: () => {}, onStart: () => {},
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  function gateRead(path: number | string, dispatch: (finish: () => void) => void): void {
    const name = typeof path === "number" ? io.descriptors.get(path) : String(path);
    if (!name || !io.root || !name.startsWith(io.root) || io.started.length >= 4 || io.gated.has(path)
      || !/^(?:read-\d\.txt|needle\.txt)$/.test(basename(name))) { dispatch(() => {}); return; }
    io.gated.add(path);
    io.started.push(basename(name));
    io.peak = Math.max(io.peak, ++io.active);
    let finish!: () => void;
    io.finished.push(new Promise<void>(resolve => { finish = resolve; }));
    const gate = new Promise<void>(resolve => { io.releases.push(resolve); });
    io.onStart();
    if (io.started.length === 4) io.ready();
    void gate.then(() => dispatch(() => { io.active--; finish(); }));
  }
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (io.root && String(args[0]).startsWith(io.root)) io.descriptors.set(fd, String(args[0]));
      return fd;
    },
    closeSync: (fd: number) => { try { actual.closeSync(fd); } finally { io.descriptors.delete(fd); io.gated.delete(fd); } },
    readFile: (path: Parameters<typeof actual.readFile>[0], options: any, callback: any) => {
      gateRead(typeof path === "number" ? path : String(path), finish => actual.readFile(path, options, (error, value) => {
        try { callback(error, value); } finally { finish(); }
      }));
    },
    read: (...args: any[]) => {
      const callback = args.pop();
      gateRead(args[0], finish => (actual.read as (...values: any[]) => void)(...args, (error: unknown, bytes: number, buffer: unknown) => {
        io.bytesRead += bytes || 0;
        try { callback(error, bytes, buffer); } finally { finish(); }
      }));
    },
  };
});
import { runNativeAgentLoop } from "./native-loop.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
import { withLocalSourceBoundary } from "../scope/local-source-boundary.js";

let root = "";
afterEach(() => {
  for (const release of io.releases) release();
  if (root) rmSync(root, { recursive: true, force: true });
  root = io.root = "";
  io.started = []; io.releases = []; io.finished = []; io.active = io.peak = 0;
  io.ready = io.onStart = () => {};
  io.descriptors.clear(); io.gated.clear(); io.bytesRead = 0;
  vi.unstubAllEnvs();
});
function executor(scopePath: string): ToolExecutor {
  return new ToolExecutor({ role: "discovery", scopePath, target: "https://example.test",
    scanId: randomUUID(), findings: [], attackResults: [], targetInfo: {} });
}

it("overlaps real file-content handlers and keeps a patch behind every prior read", async () => {
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  root = realpathSync(mkdtempSync(join(tmpdir(), "0-real-tool-io-")));
  for (let index = 0; index < 4; index++) writeFileSync(join(root, `read-${index}.txt`), index === 0 ? "original\n" : `file ${index}\n`);
  io.root = root;
  const ready = new Promise<void>(resolve => { io.ready = resolve; });
  const calls = [
    ...Array.from({ length: 4 }, (_, index) => ({ name: "read_file", input: { path: `read-${index}.txt` } })),
    { name: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: read-0.txt\n@@\n-original\n+updated\n*** End Patch" } },
    { name: "read_file", input: { path: "read-0.txt" } },
  ];
  const runtime: NativeRuntime = {
    type: "api", isAvailable: async () => true,
    executeNative: async () => ({ content: calls.map((call, index) => ({ type: "tool_use" as const, id: String(index), ...call })), stopReason: "tool_use", durationMs: 0 }),
  };
  const execution = runNativeAgentLoop({
    config: { role: "discovery", systemPrompt: "fixture", tools: calls.map(call => TOOL_DEFINITIONS[call.name]!),
      maxTurns: 1, target: "https://example.test", scanId: randomUUID(), scopePath: root },
    runtime, db: null,
  });
  // The old synchronous handlers finish without reaching this async-I/O barrier.
  const reachedBarrier = await Promise.race([ready.then(() => true), execution.then(() => false)]);
  expect(reachedBarrier).toBe(true);
  expect(io.peak).toBe(4);
  expect(io.descriptors.size).toBe(4);
  for (const release of io.releases.slice(0, 3)) release();
  await Promise.all(io.finished.slice(0, 3));
  expect(readFileSync(join(root, "read-0.txt"), "utf8")).toBe("original\n");
  io.releases[3]!();
  const state = await execution;
  const results = state.messages.flatMap(message => message.content).filter(block => block.type === "tool_result");
  expect(results.map(block => block.tool_use_id)).toEqual(calls.map((_, index) => String(index)));
  expect(results.every(block => !block.is_error)).toBe(true);
  expect(JSON.parse(String(results[0]!.content)).content).toBe("original");
  expect(JSON.parse(String(results[5]!.content)).content).toBe("updated");
  expect(io.active).toBe(0);
  expect(io.descriptors.size).toBe(0);
}, 10_000);

it.each(["read_file", "search_files"])("cancels an in-flight %s and closes its descriptor", async name => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "0-real-tool-io-")));
  writeFileSync(join(root, "read-0.txt"), "original\n");
  io.root = root;
  const started = new Promise<void>(resolve => { io.onStart = resolve; });
  const controller = new AbortController();
  const result = executor(root).execute({ name, arguments: name === "read_file" ? { path: "read-0.txt" }
    : { path: "read-0.txt", query: "original" } }, { signal: controller.signal });
  await started;
  controller.abort();
  io.releases[0]!();
  const outcome = await result;
  expect(outcome.success).toBe(false);
  expect(outcome.error).toMatch(/abort/i);
  expect(io.active).toBe(0);
  expect(io.descriptors.size).toBe(0);
}, 10_000);

it.each(["read_file", "search_files"].flatMap(name => ["file", "ancestor"].map(swap => ({ name, swap }))))(
  "keeps $name on its scoped descriptor after a $swap symlink swap", async ({ name, swap }) => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "0-real-tool-io-")));
    const scope = join(root, "scope"), outside = join(root, "outside");
    mkdirSync(join(scope, "folder"), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(scope, "folder", "needle.txt"), "safe scoped content\n");
    writeFileSync(join(outside, "needle.txt"), "SECRET_OUTSIDE_SCOPE_SENTINEL\n");
    io.root = scope;
    const started = new Promise<void>(resolve => { io.onStart = resolve; });
    const result = withLocalSourceBoundary(scope, () => executor(scope).execute({ name,
      arguments: name === "read_file" ? { path: "folder/needle.txt" } : { path: "folder", query: "SECRET_OUTSIDE_SCOPE_SENTINEL" } }));
    await started;
    if (swap === "file") {
      rmSync(join(scope, "folder", "needle.txt"));
      symlinkSync(join(outside, "needle.txt"), join(scope, "folder", "needle.txt"));
    } else {
      renameSync(join(scope, "folder"), join(scope, "original-folder"));
      symlinkSync(outside, join(scope, "folder"), "dir");
    }
    io.releases[0]!();
    const outcome = await result;
    expect(outcome.success).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("SECRET_OUTSIDE_SCOPE_SENTINEL");
    if (name === "read_file") expect(outcome.output).toMatchObject({ content: "safe scoped content" });
    else expect(outcome.output).toMatchObject({ matches: [] });
    expect(io.active).toBe(0);
    expect(io.descriptors.size).toBe(0);
  }, 10_000,
);


it("bounds a searched file that grows after the size check without returning partial matches", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "0-real-tool-io-")));
  const path = join(root, "read-0.txt");
  writeFileSync(path, "small\n");
  io.root = root;
  const started = new Promise<void>(resolve => { io.onStart = resolve; });
  const result = executor(root).execute({ name: "search_files", arguments: { path: "read-0.txt", query: "SECRET" } });
  await started;
  writeFileSync(path, "SECRET" + "x".repeat(256 * 1024 + 10));
  io.releases[0]!();
  const outcome = await result;
  expect(outcome).toMatchObject({ success: true, output: { matches: [], skippedFiles: 1 } });
  expect(io.bytesRead).toBe(256 * 1024 + 1);
  expect(io.descriptors.size).toBe(0);
}, 10_000);

it.each(["root", "above-root", "root-directory"])(
  "fails the whole search when its approved %s identity changes during content I/O", async swap => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "0-real-tool-io-")));
    const authority = join(root, "authority"), scope = join(authority, "scope"), outside = join(root, "outside");
    mkdirSync(scope, { recursive: true }); mkdirSync(join(outside, "scope"), { recursive: true });
    writeFileSync(join(scope, "read-0.txt"), "safe first file\n");
    writeFileSync(join(scope, "read-1.txt"), "safe second file\n");
    writeFileSync(join(outside, "read-1.txt"), "SECRET_OUTSIDE_ROOT_SENTINEL\n");
    writeFileSync(join(outside, "scope", "read-1.txt"), "SECRET_OUTSIDE_ROOT_SENTINEL\n");
    io.root = scope;
    const started = new Promise<void>(resolve => { io.onStart = resolve; });
    const result = withLocalSourceBoundary(scope, () => executor(scope).execute({ name: "search_files",
      arguments: { query: "SECRET_OUTSIDE_ROOT_SENTINEL" } }));
    await started;
    if (swap === "above-root") {
      renameSync(authority, join(root, "original-authority"));
      symlinkSync(outside, authority, "dir");
    } else {
      renameSync(scope, join(authority, "original-scope"));
      if (swap === "root") symlinkSync(outside, scope, "dir");
      else {
        mkdirSync(scope);
        writeFileSync(join(scope, "read-1.txt"), "SECRET_OUTSIDE_ROOT_SENTINEL\n");
      }
    }
    io.releases[0]!();
    const outcome = await result;
    expect(outcome.success, JSON.stringify(outcome)).toBe(false);
    expect(outcome.error).toMatch(/scope.*root.*changed/i);
    expect(JSON.stringify(outcome)).not.toContain("SECRET_OUTSIDE_ROOT_SENTINEL");
    expect(io.descriptors.size).toBe(0);
  }, 10_000,
);
