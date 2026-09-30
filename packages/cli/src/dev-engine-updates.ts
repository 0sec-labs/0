import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { eventBus } from "@0/core";
import type { ConsoleAutonomyMode, ConsoleSession, ConsoleSessionCheckpoint, ConsoleSessionConfig, ConsoleTurnOutcome } from "@0/core";
import type { HarnessSnapshot } from "@0/shared";
import { getSettings } from "./tui/settings-store.js";

const execute = promisify(execFile);
type EngineModule = { createConsoleSession(config: ConsoleSessionConfig): ConsoleSession };
type Notice = (message: string) => void;
const ignoredSourceNames: Record<string, true> = { node_modules: true, __tests__: true, __fixtures__: true };

function comparableCheckpoint(checkpoint: ConsoleSessionCheckpoint) {
  const extension = checkpoint.selfExtensionSnapshot;
  const harness = checkpoint.harness;
  return {
    ...checkpoint,
    // Disk-backed executable manifests are re-registered, not given new authority.
    selfExtensionSnapshot: extension ? {
      enabled: extension.enabled,
      registrations: extension.registrations.map(({ pluginId, manifest, origin, guardCount, digest }) =>
        ({ pluginId, manifest, origin, guardCount, digest })),
    } : null,
    // Provider activation may deliberately transform its supplied state.
    harness: harness ? { ...harness, providerStates: Object.keys(harness.providerStates).sort() } : null,
  };
}

function assertSessionContract(session: ConsoleSession): void {
  if (!session || typeof session !== "object" || !session.ready || typeof session.ready.then !== "function") {
    throw new Error("Built engine does not implement asynchronous session readiness");
  }
  for (const method of ["send", "cleanup", "exportCheckpoint", "prepareHandoff", "setAutonomyMode", "clearConversation", "stopPersistentAgent", "stopPersistentAgents"] as const) {
    if (typeof session[method] !== "function") throw new Error(`Built engine omitted ${method}`);
  }
}

function sourceDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || Object.hasOwn(ignoredSourceNames, entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      if ((!entry.isFile() && !entry.isSymbolicLink()) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      let readable = path;
      if (entry.isSymbolicLink()) {
        readable = realpathSync(path);
        const target = relative(root, readable);
        if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target) || !statSync(readable).isFile()) {
          throw new Error(`Source links must resolve to files inside the core source tree: ${path}`);
        }
      }
      hash.update(relative(root, path)).update("\0").update(readFileSync(readable)).update("\0");
    }
  };
  visit(root);
  return hash.digest("hex");
}

/** Stable frontend identity; only an idle, explicitly enabled dev engine changes. */
export function withDevEngineUpdates(
  initial: ConsoleSession,
  config: ConsoleSessionConfig,
  closeStore: (completed: boolean) => void,
): ConsoleSession {
  const requestedRoot = process.env["ZERO_DEV_SOURCE_ROOT"];
  const root = requestedRoot ? realpathSync(requestedRoot) : undefined;
  if (root && JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).name !== "@0/core") {
    throw new Error("ZERO_DEV_SOURCE_ROOT must identify a 0 development checkout");
  }
  let current = initial;
  let activeDigest: string | undefined;
  let rejectedDigest: string | undefined;
  let busy = false;
  let closing: Promise<void> | undefined;
  let closingStarted = false;
  let activeSend: Promise<ConsoleTurnOutcome> | undefined;
  let handoffCandidate: ConsoleSession | undefined;
  let disconnectEvents: (() => void) | undefined;
  const generations: string[] = [];

  const refresh = async (notice?: Notice, signal?: AbortSignal): Promise<void> => {
    if (closingStarted || signal?.aborted || !root || !getSettings().allowDevSourceUpdates) return;
    const notify: Notice = message => { try { notice?.(message); } catch { /* Rendering cannot replay a committed handoff. */ } };
    let candidate: ConsoleSession | undefined;
    let detach: (() => void) | undefined;
    let directory: string | undefined;
    let committed = false;
    let pendingHarnessSnapshot: HarnessSnapshot | undefined;
    try {
      const source = join(root, "packages/core/src");
      const digest = sourceDigest(source);
      if (digest === activeDigest || digest === rejectedDigest) return;
      rejectedDigest = digest;
      notify("Building changed development engine source; the current session remains active until handoff.");
      const generationRoot = join(root, "packages/core/.0/dev-engines");
      await mkdir(generationRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(generationRoot, "generation-"));
      const result = await execute(process.execPath, [join(root, "scripts/build-dev-engine.mjs"), source, directory], {
        cwd: root, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, signal,
      });
      const built = JSON.parse(result.stdout) as { digest: string; entry: string };
      if (built.digest !== digest || sourceDigest(source) !== digest) {
        throw new Error("Engine source changed during its build; no generation was activated");
      }
      signal?.throwIfAborted();
      if (closingStarted || !getSettings().allowDevSourceUpdates) throw new Error("Development engine update cancelled before activation");
      // Each specifier names a new immutable generation selected at runtime.
      const module = await import(pathToFileURL(built.entry).href) as EngineModule;
      if (typeof module.createConsoleSession !== "function") throw new Error("Built engine has no console session factory");
      const checkpoint = current.exportCheckpoint();
      candidate = module.createConsoleSession({
        ...config,
        developmentSourceRoot: root,
        initialCheckpoint: checkpoint,
        onHarnessUpdate: config.onHarnessUpdate ? snapshot => {
          if (committed) config.onHarnessUpdate?.(snapshot);
          else pendingHarnessSnapshot = snapshot;
        } : undefined,
      });
      assertSessionContract(candidate);
      handoffCandidate = candidate;
      await candidate.ready;
      if (!isDeepStrictEqual(comparableCheckpoint(candidate.exportCheckpoint()), comparableCheckpoint(checkpoint))) {
        throw new Error("Candidate engine did not preserve the session checkpoint");
      }
      const candidateBus = await import(pathToFileURL(join(directory, "runtime/events/bus.js")).href) as { eventBus: typeof eventBus };
      signal?.throwIfAborted();
      if (closingStarted || !getSettings().allowDevSourceUpdates) throw new Error("Development engine update cancelled before handoff");
      if (!isDeepStrictEqual(current.exportCheckpoint(), checkpoint)) throw new Error("Session changed during candidate preparation; keeping the current engine");
      const subscription = candidateBus.eventBus.subscribe({ emit: (type, payload) => eventBus.emit(type, payload as never) });
      if (typeof subscription !== "function") throw new Error("Built engine has an incompatible event bus");
      detach = subscription;
      const { warnings = [] } = await current.prepareHandoff();
      const previousEvents = disconnectEvents;
      disconnectEvents = detach;
      detach = undefined;
      current = candidate;
      committed = true;
      handoffCandidate = undefined;
      candidate = undefined;
      activeDigest = digest;
      rejectedDigest = undefined;
      generations.push(directory);
      directory = undefined;
      try { previousEvents?.(); }
      catch (error) { warnings.push(`Previous event bridge: ${String(error)}`); }
      if (pendingHarnessSnapshot) {
        try { config.onHarnessUpdate?.(pendingHarnessSnapshot); }
        catch (error) { warnings.push(`Harness renderer: ${String(error)}`); }
      }
      notify(`Development engine ${digest.slice(0, 12)} is active. Conversation, scope decisions and task state were retained; engine-owned resources were drained. The terminal/UI shell, injected provider/MCP clients and shared package dependencies were not reloaded.`);
      if (warnings.length) notify(`Engine handoff cleanup warnings: ${warnings.join("; ")}`);
    } catch (error) {
      if (closingStarted || signal?.aborted || !getSettings().allowDevSourceUpdates) rejectedDigest = undefined;
      const warnings: string[] = [];
      try { detach?.(); }
      catch (cleanupError) { warnings.push(`Candidate event bridge: ${String(cleanupError)}`); }
      // A rejected candidate must not close the old engine's caller-owned MCP host.
      if (!committed && typeof candidate?.prepareHandoff === "function") {
        try {
          const retirement = await candidate.prepareHandoff();
          warnings.push(...retirement.warnings ?? []);
        } catch (cleanupError) {
          warnings.push(`Candidate retirement: ${String(cleanupError)}`);
        }
      }
      notify(`Development engine ${committed ? "activated, but finalization failed" : "update was not activated"}: ${error instanceof Error ? error.message : String(error)}`);
      if (warnings.length) notify(`Rejected engine cleanup warnings: ${warnings.join("; ")}`);
    } finally {
      handoffCandidate = undefined;
      if (directory) await rm(directory, { recursive: true, force: true }).catch(error => notify(`Could not remove rejected engine generation: ${String(error)}`));
    }
  };

  const send: ConsoleSession["send"] = async (text, callbacks, options) => {
    if (closingStarted) throw new Error("Console session is closing");
    if (busy) throw new Error("A console turn or development engine handoff is already active");
    busy = true;
    rejectedDigest = undefined;
    activeSend = (async () => {
      await current.ready;
      await refresh(callbacks?.onNotice, options?.signal);
      if (closingStarted) throw new Error("Console session is closing");
      const outcome = await current.send(text, callbacks, options);
      await refresh(callbacks?.onNotice, options?.signal);
      return outcome;
    })();
    try { return await activeSend; }
    finally { busy = false; activeSend = undefined; }
  };
  const devlog = (o: Record<string, unknown>) => {
    try { appendFileSync(process.env["ZERO_TUI_LOG"] ?? "/tmp/0-tui.log", JSON.stringify({ ts: new Date().toISOString(), kind: "dev-engine", ...o }) + "\n"); } catch { /* best-effort */ }
  };
  // A cleanup step must never be able to trap the operator's exit. A live
  // engine hot-swap can leave `current` pointing at a candidate whose own
  // close depends on resources (a persistent worker, an in-flight send, a
  // handoff mid-flight) that never settle. Bound each await: a step that
  // exceeds its deadline is abandoned rather than awaited forever.
  const bounded = async (label: string, op: Promise<unknown> | undefined, ms: number): Promise<void> => {
    if (!op) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([op.then(() => "done" as const), new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ms); })]);
      devlog({ stage: label, outcome });
    } catch (error) { devlog({ stage: label, error: String(error) }); }
    finally { if (timer) clearTimeout(timer); }
  };
  const cleanup = (): Promise<void> => closing ??= (async () => {
    closingStarted = true;
    let completed = false;
    // An idle session has nothing to drain, yet one close in retire's chain
    // can still fail to settle promptly. Bound the idle case tightly and let
    // the outer 12s exit watchdog (run.tsx) cover a genuine wedge, so the
    // operator's Ctrl+C returns in well under a second instead of ~3.4s.
    const coreCleanupMs = busy ? 3000 : 300;
    devlog({ stage: "cleanup-begin", busy, coreCleanupMs });
    try {
      await bounded("await-active-send", activeSend?.catch(() => {}), 2000);
      await Promise.all([
        bounded("core-cleanup", current.cleanup(), coreCleanupMs),
        // A hot-swapped-in candidate holds its own resources; dispose it too so
        // no open handle keeps the loop alive after unmount (the +400ms tail).
        bounded("candidate-cleanup", handoffCandidate?.cleanup(), coreCleanupMs),
      ]);
      handoffCandidate = undefined;
      completed = true;
    }
    finally {
      devlog({ stage: "cleanup-drain", completed });
      try { disconnectEvents?.(); }
      finally {
        try { closeStore(completed); }
        finally { await bounded("rm-generations", Promise.all(generations.map(directory => rm(directory, { recursive: true, force: true }))), 2000); }
      }
      devlog({ stage: "cleanup-done", completed });
    }
  })();

  return new Proxy(initial, {
    get(_target, key) {
      if (key === "send") return send;
      if (key === "cleanup") return cleanup;
      if (key === "setAutonomyMode") return (mode: ConsoleAutonomyMode) => {
        current.setAutonomyMode(mode);
        handoffCandidate?.setAutonomyMode(mode);
      };
      if (key === "clearConversation") return () => {
        current.clearConversation();
        handoffCandidate?.clearConversation();
      };
      const value = Reflect.get(current, key, current) as unknown;
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
}
