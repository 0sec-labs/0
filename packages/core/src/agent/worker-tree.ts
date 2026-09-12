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
}

function workerNode(id: string, depth: number, parentId?: string): WorkerNode {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  return {
    id, parentId, depth, controller: new AbortController(),
    children: new Set(), done, finish, active: true, stopping: 0,
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
  private closed = false;

  constructor(
    readonly rootId: string,
    private readonly maxWorkers = 32,
    private readonly maxDepth = 8,
  ) {
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 ||
        !Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError("Worker capacity and depth must be positive integers");
    }
    this.nodes.set(rootId, workerNode(rootId, 0));
  }

  acquire(id: string, parentId: string): { signal: AbortSignal; release: () => void } {
    const parent = this.nodes.get(parentId);
    if (this.closed) throw new Error("Audit worker tree is closed");
    if (!parent?.active) throw new Error("Worker parent is no longer active");
    for (let ancestor: WorkerNode | undefined = parent; ancestor;
      ancestor = ancestor.parentId === undefined ? undefined : this.nodes.get(ancestor.parentId)) {
      if (ancestor.stopping || ancestor.controller.signal.aborted) {
        throw new Error("Worker subtree is stopping");
      }
    }
    if (this.nodes.has(id)) throw new Error("Worker identity is already registered");
    if (parent.depth >= this.maxDepth) throw new Error(`Worker depth limit reached (${this.maxDepth})`);
    if (this.active >= this.maxWorkers) throw new Error(`Audit worker capacity reached (${this.maxWorkers})`);
    const node = workerNode(id, parent.depth + 1, parentId);
    this.nodes.set(id, node);
    parent.children.add(id);
    this.active++;
    return {
      signal: node.controller.signal,
      release: () => {
        if (!node.active) return;
        node.active = false;
        this.active--;
        node.finish();
        this.prune(node);
      },
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
