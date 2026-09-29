import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { UnifiedApp } from "./tui/run.js";

const execute = promisify(execFile);
const enabled = process.env["ZERO_DEV_UI_WATCH"] === "1" && Boolean(process.env["ZERO_DEV_SOURCE_ROOT"]);
interface StateCell<T> {
  value: T;
  dispatch?: Dispatch<SetStateAction<T>>;
  set: Dispatch<SetStateAction<T>>;
}
export interface DevUiBoundary {
  readonly states: Map<string, unknown>;
  readonly refs: Map<string, MutableRefObject<unknown>>;
  safe: () => boolean;
  assertNativeIdle?: () => void;
  mounted: boolean;
}
const boundaries = new Map<string, DevUiBoundary>();
let remounting = false;
let remountDiagnostic: ((...details: unknown[]) => void) | undefined;

/** In-process UI ABI. These cells must NEVER be serialized: they can hold live
 * native sessions, runtime clients and checkpoint authority. Named keys survive
 * insertion/reordering of hooks; only presentation state crosses a UI remount.
 * Stable dispatchers rebind the existing engine's approval callbacks to the new
 * UI. The engine and its conversation/tool resources are not reconstructed. */
export function useDevUiBoundary(id: string): DevUiBoundary {
  const own = useRef<DevUiBoundary | null>(null);
  if (!own.current) {
    own.current = enabled ? boundaries.get(id) ?? null : null;
    if (!own.current) own.current = { states: new Map(), refs: new Map(), safe: () => false, mounted: false };
    if (enabled) boundaries.set(id, own.current);
  }
  const boundary = own.current;
  useEffect(() => {
    boundary.mounted = true;
    return () => {
      boundary.mounted = false;
      if (!remounting && boundaries.get(id) === boundary) boundaries.delete(id);
    };
  }, [boundary, id]);
  return boundary;
}

export function useDevUiState<T>(boundary: DevUiBoundary, key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>];
export function useDevUiState<T = undefined>(boundary: DevUiBoundary, key: string): [T | undefined, Dispatch<SetStateAction<T | undefined>>];
export function useDevUiState<T>(boundary: DevUiBoundary, key: string, initial?: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  let cell = boundary.states.get(key) as StateCell<T> | undefined;
  const [value, dispatch] = useState<T>(() => cell ? cell.value : typeof initial === "function" ? (initial as () => T)() : initial as T);
  if (!cell) {
    cell = { value, set: action => {
      if (cell!.dispatch) cell!.dispatch(action);
      else cell!.value = typeof action === "function" ? (action as (previous: T) => T)(cell!.value) : action;
    } };
    boundary.states.set(key, cell);
  }
  cell.value = value;
  cell.dispatch = dispatch;
  useEffect(() => () => { if (cell!.dispatch === dispatch) cell!.dispatch = undefined; }, [cell, dispatch]);
  return [value, cell.set];
}

export function useDevUiRef<T>(boundary: DevUiBoundary, key: string, initial: T): MutableRefObject<T> {
  const own = useRef<T>(initial);
  let ref = boundary.refs.get(key) as MutableRefObject<T> | undefined;
  if (!ref) { ref = own; boundary.refs.set(key, ref as MutableRefObject<unknown>); }
  return ref;
}

export function isDevUiRemount(): boolean { return remounting; }

/** OpenTUI captures console.error when constructing its reconciler container.
 * Capture a dynamically gated delegate at that boundary, then immediately
 * restore the console. Outside a reload, diagnostics remain completely intact. */
export function bindDevUiDiagnostics<T>(create: () => T): T {
  const previousError = console.error;
  const delegate = (...details: unknown[]) => {
    if (remounting) remountDiagnostic?.(...details);
    else previousError.apply(console, details);
  };
  console.error = delegate;
  try { return create(); }
  finally { if (console.error === delegate) console.error = previousError; }
}

export async function remountDevUi<T>(apply: () => T | Promise<T>): Promise<T> {
  if (remounting) throw new Error("A frontend remount is already active");
  remounting = true;
  // OpenTUI/React logs caught render errors independently of our error boundary.
  // Do not let credential-bearing candidate diagnostics enter the console/output
  // replay buffer. Native work is quiescent; only this remount is covered.
  const previousError = console.error;
  const previousWarn = console.warn;
  let reported = false;
  const safeDiagnostic = (...details: unknown[]) => {
    if (reported) return;
    reported = true;
    const error = details[0];
    const location = error instanceof Error ? error.stack?.match(/\/(ui\.js|[A-Za-z0-9_-]+\.tsx?):(\d+):(\d+)/) : undefined;
    previousWarn.call(console, `0dev: UI render diagnostic${location ? ` (${location[1]}:${location[2]}:${location[3]})` : ""} (details omitted to protect credentials).`);
  };
  console.error = safeDiagnostic;
  console.warn = safeDiagnostic;
  remountDiagnostic = safeDiagnostic;
  try { return await apply(); }
  finally {
    if (console.error === safeDiagnostic) console.error = previousError;
    if (console.warn === safeDiagnostic) console.warn = previousWarn;
    remounting = false;
    remountDiagnostic = undefined;
  }
}

/** A failed generation renders nothing only until the caller synchronously
 * remounts its known-good generation on the SAME React root/native renderer. */
export class DevUiRenderBoundary extends React.Component<{
  onFailure?: (error: unknown) => void;
  children: React.ReactNode;
}, { error: unknown; failed: boolean }> {
  state = { error: undefined as unknown, failed: false };
  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }
  componentDidCatch(error: unknown) { this.props.onFailure?.(error); }
  render() {
    if (this.state.failed && !remounting) throw this.state.error;
    return this.state.failed ? null : this.props.children;
  }
}

/** OpenTUI 0.5.4 root.render creates a fresh reconciler container per call.
 * Mount this host ONCE and replace its child through React state instead; old
 * effects/input subscriptions then unmount normally on the existing container. */
export function DevUiHost({ initial, onReady }: {
  initial: React.ReactNode;
  onReady: (update: ((node: React.ReactNode) => void) | undefined) => void;
}) {
  const [view, setView] = useState(initial);
  useLayoutEffect(() => {
    onReady(setView);
    return () => onReady(undefined);
  }, [onReady]);
  return view;
}

function uiDigest(directory: string): string {
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["node_modules", "__tests__", "__fixtures__"].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      hash.update(relative(directory, file)).update("\0").update(readFileSync(file)).update("\0");
    }
  };
  visit(directory);
  return hash.digest("hex");
}

export interface DevUiGeneration {
  UnifiedApp: typeof UnifiedApp;
}
export interface DevUiReloadController {
  stop(): Promise<void>;
}

/** Opt-in only through the explicit 0dev launcher, never project preferences.
 * Safe frontend remount, NOT component FastRefresh. Non-UI CLI, core, shared
 * dependencies, startup/native integration and this ABI need a full 0dev build.
 * The separate engine-source-update preference retains its existing behavior. */
export function startDevUiReload(options: {
  apply: (generation: DevUiGeneration, digest: string) => void | Promise<void>;
  notice: (text: string) => void;
}): DevUiReloadController | undefined {
  if (!enabled) return undefined;
  const root = realpathSync(process.env["ZERO_DEV_SOURCE_ROOT"]!);
  if (JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).name !== "@0/cli") {
    throw new Error("ZERO_DEV_SOURCE_ROOT must identify the explicitly launched development checkout");
  }
  const source = join(root, "packages/cli/src/tui");
  let currentDigest = uiDigest(source);
  let attemptedDigest = currentDigest;
  let pending: { module: DevUiGeneration; digest: string; directory: string } | undefined;
  let activeDirectory: string | undefined;
  let directoryRoot: string | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  const notice = (text: string) => { if (!stopped) options.notice(`0dev: ${text}`); };
  const remove = (directory: string | undefined) => directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve();
  const safe = () => {
    if (!boundaries.get("console")?.mounted) return false;
    for (const boundary of boundaries.values()) {
      if (!boundary.mounted || !boundary.safe()) return false;
    }
    try {
      for (const boundary of boundaries.values()) boundary.assertNativeIdle?.();
    } catch { return false; }
    return true;
  };
  const activate = async () => {
    if (stopped || !pending || !safe()) return;
    const candidate = pending;
    pending = undefined;
    const previous = activeDirectory;
    try {
      // No asynchronous work between the final guard and entering the remount.
      // Session exportCheckpoint guards include workers/harness native activity.
      await remountDevUi(() => options.apply(candidate.module, candidate.digest));
      activeDirectory = candidate.directory;
      currentDigest = candidate.digest;
      notice(`UI ${candidate.digest.slice(0, 12)} active (safe frontend remount; engine/conversation retained).`);
      await remove(previous).catch(() => notice("UI is active; old generation cleanup failed and will be retried on exit."));
    } catch {
      // The apply callback restores the known-good tree before rejecting.
      notice("UI candidate rejected during mount; known-good view and live session retained.");
      await remove(candidate.directory);
    }
  };
  const build = async () => {
    if (stopped) return;
    let directory: string | undefined;
    let phase: "build" | "import" = "build";
    try {
      const digest = uiDigest(source);
      if (digest === attemptedDigest) { await activate(); return; }
      attemptedDigest = digest;
      if (pending) { await remove(pending.directory); pending = undefined; }
      if (!directoryRoot) {
        const generations = join(root, "packages/cli/.0/dev-ui");
        await mkdir(generations, { recursive: true, mode: 0o700 });
        directoryRoot = await mkdtemp(join(generations, "watch-"));
      }
      directory = await mkdtemp(join(directoryRoot, "generation-"));
      const result = await execute(process.execPath, [join(root, "scripts/build-dev-ui.mjs"), root, directory], {
        cwd: root, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, signal: abort.signal,
      });
      const built = JSON.parse(result.stdout) as { digest: string; entry: string };
      if (built.digest !== digest || uiDigest(source) !== digest) {
        attemptedDigest = currentDigest;
        schedule();
        return;
      }
      // Every specifier names a new immutable generation selected at runtime.
      phase = "import";
      const module = await import(pathToFileURL(built.entry).href) as DevUiGeneration;
      if (typeof module.UnifiedApp !== "function") throw new Error("Incompatible UI generation");
      if (stopped) return;
      pending = { module, digest, directory };
      directory = undefined;
      await activate();
      if (pending) notice("UI candidate ready; waiting for all audits/workers and approval/auth flows to become idle.");
    } catch (error) {
      // Extract only a constrained source location, never the candidate message,
      // stack, arguments or checkpoint. Provider errors can contain credentials.
      const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      const location = phase === "build" ? stderr.match(/source\/(tui\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?):(\d+):(\d+)/) : undefined;
      notice(`UI candidate ${phase} failed${location ? ` (${location[1]}:${location[2]}:${location[3]})` : phase === "import" ? " (ui.js)" : ""}; known-good view retained. Fix the UI source to retry.`);
    } finally { await remove(directory); }
  };
  const run = () => {
    if (stopped) return;
    if (running) { schedule(); return; }
    running = build().finally(() => { running = undefined; });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 180);
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    watcher?.close();
    clearTimeout(timer);
    clearInterval(retry);
    await running;
    await remove(directoryRoot);
    boundaries.clear();
  };
  try {
    watcher = watch(join(root, "packages/cli/src"), { recursive: true }, (_event, filename) => {
      const name = String(filename ?? "");
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || name.endsWith(".d.ts")) return;
      if (name.startsWith("tui/") && !["tui/settings-store.ts", "tui/output-guard.ts", "tui/tui-crash.tsx"].includes(name)) schedule();
      else notice("Shared CLI/startup service changed; restart 0dev for a coherent full rebuild.");
    });
    watcher.on("error", () => { notice("UI watcher failed; restart 0dev --watch."); void stop(); });
    retry = setInterval(() => { if (!running && pending) running = activate().finally(() => { running = undefined; }); }, 300);
    retry.unref();
    notice("watching trusted TUI source; safe frontend remount (not FastRefresh). Core/dependencies/startup changes require a full rebuild.");
  } catch {
    notice("UI watcher could not start; normal known-good UI remains active.");
    void stop();
  }
  return { stop };
}
