import { subagentWorkerLimit } from "./subagent-limits.js";

export interface WorkerWorkspace { key: string; guardedKeys?: string[]; writeCapable: boolean; readOnly: boolean }
export interface LocalEffectObservations { attempts: number; tools: string[]; observedWrites: number }

export interface OwnedWorkerSnapshot {
  workspace?: WorkerWorkspace;
  localEffects: LocalEffectObservations;
  id: string;
  parentId: string;
  depth: number;
  status: "queued" | "running" | "parked" | "completed" | "failed" | "stopped" | "stopping" | "unknown";
  live: boolean;
  subtreeLive: boolean;
  cleanup: "pending" | "drained";
  effects: "unknown";
  name?: string;
  task?: string;
  done?: boolean;
  completion_reason?: string;
  error?: string;
  summary?: string;
}
interface WorkerNode {
  readonly id: string;
  readonly parentId?: string;
  readonly depth: number;
  readonly controller: AbortController;
  readonly children: Set<string>;
  readonly done: Promise<void>;
  readonly finish: () => void;
  active: boolean;
  stopping: number;
  evictedTerminal: number;
  workspace?: WorkerWorkspace;
  localEffects: LocalEffectObservations;
  observation?: Partial<OwnedWorkerSnapshot>;
}

function workerNode(id: string, depth: number, parentId?: string): WorkerNode {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  return {
    id, parentId, depth, controller: new AbortController(),
    children: new Set(), done, finish, active: true, stopping: 0, evictedTerminal: 0,
    localEffects: { attempts: 0, tools: [], observedWrites: 0 },
  };
}

/**
 * One audit's worker tree. Parked and queued workers consume capacity too.
 * Completed ancestors retain only ancestry until their final descendant exits.
 * No admission queue: waiting ancestors must never deadlock behind their children.
 */
export class AuditWorkerTree {
  private readonly nodes = new Map<string, WorkerNode>();
  private active = 0;
  private readonly mutations = new Map<string, Map<string, number>>();
  private closed = false;
  private readonly terminal = new Map<string, { worker: OwnedWorkerSnapshot; owners: Set<string> }>();

  constructor(
    readonly rootId: string,
    private readonly maxWorkers = subagentWorkerLimit(),
    private readonly maxDepth = 8,
    private readonly terminalLimit = 256,
  ) {
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 ||
        !Number.isSafeInteger(maxDepth) || maxDepth < 1 ||
        !Number.isSafeInteger(terminalLimit) || terminalLimit < 1) {
      throw new RangeError("Worker capacity and depth must be positive integers");
    }
    this.nodes.set(rootId, workerNode(rootId, 0));
  }

  /** Discover only live siblings under the same coordinator. */
  peers(parentId: string): string[] {
    const parent = this.nodes.get(parentId);
    if (this.closed || !parent || parent.stopping || parent.controller.signal.aborted) return [];
    return [...parent.children].filter(id => {
      const node = this.nodes.get(id);
      return node?.active && !node.stopping && !node.controller.signal.aborted;
    });
  }

  acquire(id: string, parentId: string, metadata?: { name?: string; task?: string; workspace?: WorkerWorkspace }): { signal: AbortSignal; release: () => void } {
    const parent = this.nodes.get(parentId);
    if (this.closed) throw new Error("Audit worker tree is closed");
    if (!parent?.active) throw new Error("Worker parent is no longer active");
    for (let ancestor: WorkerNode | undefined = parent; ancestor;
      ancestor = ancestor.parentId === undefined ? undefined : this.nodes.get(ancestor.parentId)) {
      if (ancestor.stopping || ancestor.controller.signal.aborted) {
        throw new Error("Worker subtree is stopping");
      }
    }
    if (this.nodes.has(id) || this.terminal.has(id)) throw new Error("Worker identity is already registered");
    if (parent.depth >= this.maxDepth) throw new Error(`Worker depth limit reached (${this.maxDepth})`);
    if (this.active >= this.maxWorkers) throw new Error(`Audit worker capacity reached (${this.maxWorkers})`);
    const workspace = metadata?.workspace ? { ...metadata.workspace, guardedKeys: [...new Set(metadata.workspace.guardedKeys ?? [metadata.workspace.key])] } : undefined;
    if (parent.workspace?.readOnly && !workspace?.readOnly) throw new Error("A read-only worker cannot delegate writable work");
    if (workspace?.writeCapable) for (const key of workspace.guardedKeys!) this.assertCheckoutAvailable(key, id);
    const node = workerNode(id, parent.depth + 1, parentId);
    node.workspace = workspace;
    node.observation = { status: "queued", ...(metadata?.name ? { name: metadata.name.slice(0, 256) } : {}), ...(metadata?.task ? { task: metadata.task.slice(0, 8000) } : {}) };
    this.nodes.set(id, node);
    parent.children.add(id);
    this.active++;
    return {
      signal: node.controller.signal,
      release: () => {
        if (!node.active) return;
        node.active = false;
        this.active--;
        const owners = new Set<string>();
        for (let ancestor = this.nodes.get(parentId); ancestor; ancestor = ancestor.parentId ? this.nodes.get(ancestor.parentId) : undefined) owners.add(ancestor.id);
        this.terminal.set(id, { worker: this.describe(node), owners });
        while (this.terminal.size > this.terminalLimit) {
          const oldest = this.terminal.keys().next().value!;
          for (const owner of this.terminal.get(oldest)!.owners) {
            const coordinator = this.nodes.get(owner);
            if (coordinator) coordinator.evictedTerminal++;
          }
          this.terminal.delete(oldest);
        }
        node.finish();
        this.prune(node);
      },
    };
  }

  workspace(id: string): WorkerWorkspace | undefined { const value = this.nodes.get(id)?.workspace; return value ? { ...value, guardedKeys: [...(value.guardedKeys ?? [value.key])] } : undefined; }

  private assertCheckoutAvailable(key: string, callerId: string): void {
    const writer = [...this.nodes.values()].find(node => node.active && node.id !== callerId && node.workspace?.writeCapable && (node.workspace.guardedKeys ?? [node.workspace.key]).includes(key));
    const mutation = [...(this.mutations.get(key) ?? [])].some(([id, count]) => id !== callerId && count > 0);
    if (writer || mutation) throw new Error("Shared checkout is busy with writable work. Wait for cleanup, use read_only:true for review, or use an isolated checkout.");
  }

  /** Synchronous admission excludes both queued child writers and in-flight parent edits. */
  beginLocalMutation(id: string, roots: string | readonly string[], tool: string): () => void {
    if (this.workspace(id)?.readOnly) throw new Error("Read-only delegation cannot execute local mutation-capable tools");
    const keys = [...new Set(typeof roots === "string" ? [roots] : roots)];
    for (const key of keys) this.assertCheckoutAvailable(key, id);
    for (const key of keys) {
      const entries = this.mutations.get(key) ?? new Map<string, number>();
      this.mutations.set(key, entries);
      entries.set(id, (entries.get(id) ?? 0) + 1);
    }
    const node = this.nodes.get(id);
    if (node) {
      node.localEffects.attempts++;
      if (!node.localEffects.tools.includes(tool)) node.localEffects.tools.push(tool);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const entries = this.mutations.get(key)!;
        const count = (entries.get(id) ?? 1) - 1;
        if (count) entries.set(id, count); else entries.delete(id);
        if (!entries.size) this.mutations.delete(key);
      }
    };
  }

  observeDirectWrite(id: string): void { const node = this.nodes.get(id); if (node) node.localEffects.observedWrites++; }

  /** Written synchronously before UI events; event delivery is not roster authority. */
  observeLifecycle(payload: { agent_id: string; status: OwnedWorkerSnapshot["status"]; name?: string; task?: string; done?: boolean; completion_reason?: string; error?: string; summary?: string }): void {
    const node = this.nodes.get(payload.agent_id);
    if (!node?.active || node.id === this.rootId) return;
    const prior = node.observation ?? {};
    node.observation = { ...prior, ...(payload.status === "queued" || payload.status === "running" ? { done: undefined, completion_reason: undefined, error: undefined, summary: undefined } : {}), status: payload.status,
      ...(payload.name !== undefined ? { name: payload.name.slice(0, 256) } : {}),
      ...(payload.task !== undefined ? { task: payload.task.slice(0, 8000) } : {}),
      ...(payload.done !== undefined ? { done: payload.done } : {}),
      ...(payload.completion_reason !== undefined ? { completion_reason: payload.completion_reason.slice(0, 128) } : {}),
      ...(payload.error !== undefined ? { error: payload.error.slice(0, 2000) } : {}),
      ...(payload.summary !== undefined ? { summary: payload.summary.slice(0, 8000) } : {}),
    };
  }

  snapshot(ownerId = this.rootId): { workers: OwnedWorkerSnapshot[]; terminalRetentionLimit: number; evictedTerminal: number } {
    const liveSubtrees = new Set<string>();
    for (const node of this.nodes.values()) if (node.active && node.id !== this.rootId) {
      for (let ancestor: WorkerNode | undefined = node; ancestor; ancestor = ancestor.parentId ? this.nodes.get(ancestor.parentId) : undefined) liveSubtrees.add(ancestor.id);
    }
    const workers = [...this.nodes.values()].filter(node => node.id !== ownerId && (node.active || liveSubtrees.has(node.id)) && this.belongsTo(node, ownerId)).map(node => this.describe(node));
    const included = new Set(workers.map(worker => worker.id));
    for (const entry of this.terminal.values()) if (entry.owners.has(ownerId) && !included.has(entry.worker.id)) workers.push({ ...entry.worker, ...(entry.worker.workspace ? { workspace: { ...entry.worker.workspace, guardedKeys: [...(entry.worker.workspace.guardedKeys ?? [entry.worker.workspace.key])] } } : {}), localEffects: { ...entry.worker.localEffects, tools: [...entry.worker.localEffects.tools] } });
    for (const worker of workers) {
      worker.subtreeLive = liveSubtrees.has(worker.id);
      worker.cleanup = worker.subtreeLive ? "pending" : "drained";
    }
    return { workers, terminalRetentionLimit: this.terminalLimit, evictedTerminal: this.nodes.get(ownerId)?.evictedTerminal ?? 0 };
  }

  private describe(node: WorkerNode): OwnedWorkerSnapshot {
    const observed = node.observation ?? {};
    const terminalStatus = observed.status === "completed" || observed.status === "failed" || observed.status === "stopped" ? observed.status : "unknown";
    return { ...observed, id: node.id, parentId: node.parentId!, depth: node.depth,
      status: node.active ? (node.stopping || node.controller.signal.aborted ? "stopping" : observed.status ?? "queued") : node.controller.signal.aborted ? "stopped" : terminalStatus,
      ...(node.workspace ? { workspace: { ...node.workspace, guardedKeys: [...(node.workspace.guardedKeys ?? [node.workspace.key])] } } : {}),
      localEffects: { ...node.localEffects, tools: [...node.localEffects.tools] },
      live: node.active, subtreeLive: node.active, cleanup: node.active ? "pending" : "drained", effects: "unknown",
    };
  }

  /** Stop a target subtree, never the caller itself or a foreign worker. */
  async stop(id: string, ownerId = this.rootId): Promise<boolean> {
    if (id === ownerId || id === this.rootId) return false;
    const target = this.nodes.get(id);
    if (!target || !this.belongsTo(target, ownerId)) return false;
    await this.drain(target, true);
    return true;
  }

  /** Drain descendants; the owner may spawn again after every drain completes. */
  async stopAll(ownerId = this.rootId): Promise<void> {
    const owner = this.nodes.get(ownerId);
    if (owner) await this.drain(owner, false);
  }

  /** Audit disposal permanently prevents admission, including late continuations. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stopAll();
  }

  /**
   * True when at least one worker acquired through this tree is still alive.
   * Used by ToolExecutor.exportCheckpoint() to reject checkpoint serialisation
   * while owned background workers may still mutate findings or authority state.
   */
  hasLiveWorkers(): boolean {
    return this.active > 0;
  }

  private belongsTo(node: WorkerNode, ownerId: string): boolean {
    for (let current: WorkerNode | undefined = node; current;
      current = current.parentId === undefined ? undefined : this.nodes.get(current.parentId)) {
      if (current.id === ownerId) return true;
    }
    return false;
  }

  private async drain(owner: WorkerNode, includeOwner: boolean): Promise<void> {
    owner.stopping++;
    const subtree: WorkerNode[] = [];
    const visit = (node: WorkerNode): void => {
      subtree.push(node);
      for (const childId of node.children) {
        const child = this.nodes.get(childId);
        if (child) visit(child);
      }
    };
    // Snapshot before abort callbacks can synchronously release and prune nodes.
    if (includeOwner) visit(owner);
    else for (const id of owner.children) {
      const child = this.nodes.get(id);
      if (child) visit(child);
    }
    try {
      for (const node of subtree) {
        if (node.active) node.controller.abort(new DOMException("Worker stopped by operator", "AbortError"));
      }
      await Promise.all(subtree.map(node => node.done));
    } finally {
      owner.stopping--;
      this.prune(owner);
    }
  }

  private prune(node: WorkerNode): void {
    while (node.parentId !== undefined && !node.active && !node.stopping && node.children.size === 0) {
      const parent = this.nodes.get(node.parentId);
      this.nodes.delete(node.id);
      parent?.children.delete(node.id);
      if (!parent) return;
      node = parent;
    }
  }
}
