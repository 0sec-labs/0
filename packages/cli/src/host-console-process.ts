import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { encodeHostConsoleFrames, HostConsoleFrameReader, type HostConsoleFrame, type HostConsoleStopResult } from "./host-console-protocol.js";

interface ProcessIdentity { pid: number; parent: number; group: number; started: string; zombie: boolean }
interface Resource { identity: ProcessIdentity; group: boolean }

function identity(pid: number): ProcessIdentity | undefined {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "ppid=,pgid=,stat=,lstart="], { encoding: "utf8", timeout: 1000 }).trim();
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(value);
    return match ? { pid, parent: Number(match[1]), group: Number(match[2]), started: match[4]!.trim().replace(/\s+/g, " "), zombie: match[3]!.startsWith("Z") } : undefined;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined;
    throw new Error("Cannot inspect owned process identity");
  }
}

function live(resource: Resource): boolean {
  if (resource.group) {
    try {
      const leader = identity(resource.identity.pid);
      if (leader && leader.group === leader.pid && leader.started !== resource.identity.started) return false;
      const table = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 1000 });
      return table.split("\n").some(line => { const [group, state] = line.trim().split(/\s+/); return Number(group) === resource.identity.pid && !state?.startsWith("Z"); });
    } catch { return true; } // Failure to inspect is not proof of termination.
  }
  try {
    const current = identity(resource.identity.pid);
    return !!current && current.started === resource.identity.started && !current.zombie;
  } catch { return true; }
}

/** One async OS snapshot per drain poll, never one blocking ps per resource. */
async function processTable(): Promise<Map<number, ProcessIdentity>> {
  const raw = await new Promise<string>((resolve, reject) => execFile("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const table = new Map<number, ProcessIdentity>();
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), zombie: match[4]!.startsWith("Z"), started: match[5]!.trim().replace(/\s+/g, " ") });
  }
  return table;
}

function liveInTable(resource: Resource, table: Map<number, ProcessIdentity>): boolean {
  const leader = table.get(resource.identity.pid);
  if (!resource.group) return !!leader && !leader.zombie && leader.started === resource.identity.started;
  if (leader && leader.group === leader.pid && leader.started !== resource.identity.started) return false;
  return [...table.values()].some(process => process.group === resource.identity.pid && !process.zombie);
}

export interface HostConsoleProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onSnapshot?: (value: unknown) => void;
  onEvent?: (frame: HostConsoleFrame) => void;
  onCallback?: (name: string, args: unknown[]) => Promise<unknown>;
  graceMs?: number;
  confirmationMs?: number;
}

/** One dedicated host process. This is lifecycle isolation, not an OS sandbox. */
export class HostConsoleProcess {
  readonly pid: number;
  latestSnapshot: unknown;
  #child: ChildProcess;
  #input: Writable;
  #pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();
  #resources: Resource[] = [];
  #creating = new Set<string>();
  #exited = false;
  #closed = false;
  #revoked = false;
  #stop?: Promise<HostConsoleStopResult>;
  #invalidResource = false;
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #callbacks = new Set<string>();
  #hostCallbacks = new Set<Promise<unknown>>();

  constructor(readonly options: HostConsoleProcessOptions) {
    if (process.platform === "win32") throw new Error("Host session process containment is not qualified on Windows");
    this.#ready = new Promise((yes, no) => { this.#resolveReady = yes; this.#rejectReady = no; });
    void this.#ready.catch(() => {});
    this.#child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    this.pid = this.#child.pid ?? 0;
    this.#input = this.#child.stdio[3] as Writable;
    this.#input.on("error", () => { /* Exit handler settles requests; no uncaught EPIPE. */ });
    // Dedicated fd 3/4 carry control. Tool/provider stdout can never be a frame.
    this.#child.stdout?.resume(); this.#child.stderr?.resume();
    const reader = new HostConsoleFrameReader();
    const output = this.#child.stdio[4] as Readable;
    output.setEncoding("utf8");
    output.on("data", (data: string) => {
      try { reader.push(data, frame => this.#receive(frame)); }
      catch { this.#invalidResource = true; void this.forceStop(); }
    });
    this.#child.once("error", () => this.#fail(new Error("Host session process could not start")));
    this.#child.once("exit", () => {
      this.#exited = true;
      // Pending turns settle only after owned resources are confirmed too.
      // An unexpected worker exit also drains registered detached children.
      if (!this.#stop) void this.forceStop();
    });
    this.#child.once("close", () => { this.#closed = true; });
    try {
      const main = this.pid > 1 ? identity(this.pid) : undefined;
      if (main && main.group === this.pid) this.#resources.push({ identity: main, group: true });
      else { this.#invalidResource = true; void this.forceStop(); }
    } catch { this.#invalidResource = true; void this.forceStop(); }
  }

  #fail(error: Error): void {
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #write(frame: HostConsoleFrame): void {
    if (this.#revoked || this.#exited) throw new Error("Host session execution is fenced");
    for (const chunk of encodeHostConsoleFrames(frame)) this.#input.write(chunk);
  }

  #receive(frame: HostConsoleFrame): void {
    const resourceFrame = ["resource-begin", "resource", "resource-failed"].includes(frame.type);
    if (this.#revoked && !resourceFrame) return;
    if (frame.type === "resource-begin") {
      if (!frame.id || this.#creating.has(frame.id) || this.#creating.size >= 1024) this.#invalidResource = true;
      else this.#creating.add(frame.id);
      return;
    }
    if (frame.type === "resource-failed") {
      if (!frame.id || !this.#creating.delete(frame.id)) this.#invalidResource = true;
      return;
    }
    if (frame.type === "ready") { this.#resolveReady(); return; }
    if (frame.type === "snapshot") { this.latestSnapshot = structuredClone(frame.value); this.options.onSnapshot?.(this.latestSnapshot); return; }
    if (frame.type === "resource") {
      if (!frame.id || !this.#creating.delete(frame.id)) { this.#invalidResource = true; return; }
      const pid = frame.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) < 2 || this.#resources.length >= 1024) { this.#invalidResource = true; return; }
      const owned = identity(pid as number);
      if (!owned) {
        // A fast launcher can exit while its detached group still lives. An
        // absent leader is clean only when that group is also absent; without
        // ancestry proof an extant orphan group must be quarantined, not killed.
        if (live({ identity: { pid: pid as number, parent: 0, group: pid as number, started: "", zombie: false }, group: true })) this.#invalidResource = true;
        return;
      }
      let cursor: ProcessIdentity | undefined = owned;
      for (let depth = 0; cursor && cursor.parent !== this.pid && depth < 64; depth++) cursor = identity(cursor.parent);
      if (!owned || cursor?.parent !== this.pid || (frame.group === true && owned.group !== owned.pid)) {
        this.#invalidResource = true; return;
      }
      this.#resources.push({ identity: owned, group: owned.group === owned.pid });
      return;
    }
    if (frame.type === "callback") {
      if (typeof frame.name !== "string" || !this.#callbacks.has(frame.name) || !Array.isArray(frame.args) || this.#hostCallbacks.size >= 64) { this.#invalidResource = true; return; }
      const id = frame.id;
      const name = frame.name; const args = frame.args;
      const callback = Promise.resolve().then(() => {
        if (this.#revoked) throw new Error("Host callback was revoked before dispatch");
        return this.options.onCallback!(name, args);
      });
      this.#hostCallbacks.add(callback);
      void callback.then(
        value => { if (!this.#revoked && !this.#exited) this.#write({ type: "callback-result", id, value }); },
        () => { if (!this.#revoked && !this.#exited) this.#write({ type: "callback-result", id, error: "Host callback failed" }); },
      ).catch(() => {}).finally(() => this.#hostCallbacks.delete(callback));
      return;
    }
    if (frame.type === "result" || frame.type === "error") {
      if (frame.type === "error" && !frame.id) {
        this.#rejectReady(new Error("Host session initialization failed"));
        void this.forceStop(); return;
      }
      const pending = frame.id ? this.#pending.get(frame.id) : undefined;
      if (frame.id) this.#pending.delete(frame.id);
      if (frame.type === "error") pending?.reject(new Error(typeof frame.error === "string" ? frame.error : "Host session request failed"));
      else pending?.resolve(frame.value);
      return;
    }
    this.options.onEvent?.(frame);
  }

  async start(bootstrap: object & { callbacks?: string[] }): Promise<void> {
    if (bootstrap.callbacks?.length && !this.options.onCallback) throw new Error("Host callback bridge is required");
    this.#callbacks = new Set(bootstrap.callbacks ?? []);
    try { this.#write({ type: "init", value: bootstrap }); }
    catch (error) { void this.forceStop(); throw error; }
    return this.#ready;
  }

  async request(op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    await this.#ready;
    if (this.#revoked || this.#exited) throw new Error("Host session execution is fenced");
    if (this.#pending.size >= 64) throw new Error("Host session request limit exceeded");
    const id = randomUUID();
    const result = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    try { this.#write({ type: "request", id, op, ...payload }); }
    catch (error) { this.#pending.delete(id); throw error; }
    return result;
  }

  abort(reason = "Operator requested cancellation"): void { this.#write({ type: "abort", reason }); }

  /** Revocation precedes signals; success requires observed OS termination. */
  forceStop(): Promise<HostConsoleStopResult> {
    return this.#stop ??= this.#terminate();
  }

  async #terminate(): Promise<HostConsoleStopResult> {
    this.#revoked = true;
    let table: Map<number, ProcessIdentity> | undefined;
    const inspect = async () => {
      try { table = await processTable(); }
      catch { this.#invalidResource = true; table = undefined; }
    };
    const signalAll = (signal: NodeJS.Signals) => {
      for (const resource of this.#resources) {
        if (!table || !liveInTable(resource, table)) continue;
        try { process.kill(resource.group ? -resource.identity.pid : resource.identity.pid, signal); } catch { /* Confirm below. */ }
      }
      if (!this.#exited && (!table || !this.#resources.some(resource => resource.group && resource.identity.pid === this.pid))) {
        try { this.#child.kill(signal); } catch { /* Confirm below. */ }
      }
    };
    const wait = async (ms: number, hard = false) => {
      const deadline = Date.now() + ms;
      for (;;) {
        await inspect();
        if (hard) signalAll("SIGKILL"); // Includes resources registered during revocation.
        const resourcesLive = !table || this.#resources.some(resource => liveInTable(resource, table!));
        if (this.#closed && this.#hostCallbacks.size === 0 && !resourcesLive) return;
        if (Date.now() >= deadline) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await inspect();
    signalAll("SIGTERM");
    await wait(this.options.graceMs ?? 250);
    signalAll("SIGKILL");
    await wait(this.options.confirmationMs ?? 2000, true);
    const resourcesStopped = !!table && this.#closed && this.#creating.size === 0 && this.#hostCallbacks.size === 0 && !this.#invalidResource && !this.#resources.some(resource => liveInTable(resource, table!));
    const quarantined = !this.#exited || !resourcesStopped;
    this.#fail(new Error(quarantined ? "Host session stop could not be confirmed; execution quarantined" : "Host session execution stopped"));
    this.#input.destroy();
    return { processExited: this.#exited, resourcesStopped, quarantined,
      ...(quarantined ? { error: "Unconfirmed owned resources; do not reuse this execution" } : {}) };
  }
}
