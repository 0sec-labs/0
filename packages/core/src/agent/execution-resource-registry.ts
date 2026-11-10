import type { ChildProcess } from "node:child_process";

export interface ExecutionResource { pid: number; group?: boolean }
export type ExecutionResourceEvent =
  | { type: "creating"; id: string }
  | ({ type: "registered"; id: string } & ExecutionResource)
  | { type: "failed"; id: string };

let observer: ((resource: ExecutionResourceEvent) => void) | undefined;
let nextId = 0;

/** Dedicated execution workers install this before creating tool resources. */
export function observeExecutionResources(next: (resource: ExecutionResourceEvent) => void): () => void {
  if (observer) throw new Error("An execution resource observer is already installed");
  observer = next;
  return () => { if (observer === next) observer = undefined; };
}

/** Call BEFORE OS spawn: an interrupted creation must remain visibly unconfirmed. */
export function beginExecutionResource(): { register(resource: ExecutionResource): void; failed(): void } {
  const sink = observer;
  const id = `spawn-${++nextId}`;
  sink?.({ type: "creating", id });
  let settled = false;
  return {
    register(resource) {
      if (settled) throw new Error("Execution resource creation is already settled");
      if (!Number.isSafeInteger(resource.pid) || resource.pid < 2) throw new Error("Invalid execution resource PID");
      settled = true;
      sink?.({ type: "registered", id, pid: resource.pid, ...(resource.group ? { group: true } : {}) });
    },
    failed() {
      if (settled) return;
      settled = true;
      sink?.({ type: "failed", id });
    },
  };
}

/** Tool resource tracking is enabled only inside a dedicated session worker. */
export function hasExecutionResourceObserver(): boolean { return observer !== undefined; }

/** Publish intent before entering the OS, including failed/asynchronous spawns. */
export function trackExecutionResourceSpawn<T extends ChildProcess>(create: () => T, group = false): T {
  if (!observer) return create();
  const creation = beginExecutionResource();
  try {
    const child = create();
    let settled = false;
    const register = () => {
      if (settled) return;
      if (!child.pid) return;
      creation.register({ pid: child.pid, group });
      settled = true;
    };
    if (child.pid) register();
    else child.once("spawn", register);
    child.once("error", () => { if (!settled) { settled = true; creation.failed(); } });
    return child;
  } catch (error) { creation.failed(); throw error; }
}
