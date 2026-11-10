import { describe, expect, it } from "vitest";
import { AuditWorkerTree } from "./worker-tree.js";

describe("authoritative owned worker roster", () => {
  it("includes descendants but excludes caller, ancestors and sibling subtrees", async () => {
    const tree = new AuditWorkerTree("root");
    const a = tree.acquire("a", "root", { name: "A", task: "Inspect" });
    const b = tree.acquire("b", "root");
    const child = tree.acquire("child", "a");
    expect(tree.snapshot().workers.map(w => w.id)).toEqual(["a", "b", "child"]);
    expect(tree.snapshot("a").workers.map(w => w.id)).toEqual(["child"]);
    expect(tree.snapshot("foreign").workers).toEqual([]);
    expect(await tree.stop("root", "a")).toBe(false);
    expect(await tree.stop("a", "a")).toBe(false);
    expect(await tree.stop("b", "a")).toBe(false);
    child.release(); a.release(); b.release(); await tree.close();
  });
  it("keeps stopping live until cleanup releases its lease", async () => {
    const tree = new AuditWorkerTree("root");
    const worker = tree.acquire("worker", "root");
    tree.observeLifecycle({ agent_id: "worker", status: "running" });
    let completed = false;
    const pending = tree.stop("worker").then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(tree.snapshot().workers[0]).toMatchObject({ status: "stopping", live: true, cleanup: "pending", effects: "unknown" });
    worker.release(); await pending;
    expect(tree.snapshot().workers[0]).toMatchObject({ status: "stopped", live: false, cleanup: "drained", effects: "unknown" });
    await tree.close();
  });
  it("bounds terminal history without evicting live workers or inventing write outcomes", async () => {
    const tree = new AuditWorkerTree("root", 2, 8, 2);
    const live = tree.acquire("live", "root");
    for (let n = 0; n < 4; n++) {
      const id = `done-${n}`; const worker = tree.acquire(id, "root");
      tree.observeLifecycle({ agent_id: id, status: "failed", error: "provider outcome unknown", done: false, completion_reason: "error" });
      worker.release();
    }
    const snapshot = tree.snapshot();
    expect(snapshot.workers.map(w => w.id)).toEqual(["live", "done-2", "done-3"]);
    expect(snapshot.evictedTerminal).toBe(2);
    expect(snapshot.workers[1]).toMatchObject({ status: "failed", cleanup: "drained", done: false, completion_reason: "error", effects: "unknown" });
    snapshot.workers[1].error = "tampered";
    expect(tree.snapshot().workers[1].error).toBe("provider outcome unknown");
    live.release(); await tree.close();
  });
});

it("keeps completed ancestors discoverable through history churn and scopes eviction counts", async () => {
  const tree = new AuditWorkerTree("root", 4, 8, 1);
  const owner = tree.acquire("owner", "root");
  const sibling = tree.acquire("sibling", "root");
  const parent = tree.acquire("parent", "owner");
  const child = tree.acquire("child", "parent");
  tree.observeLifecycle({ agent_id: "parent", status: "completed" }); parent.release();
  for (let n = 0; n < 3; n++) { const worker = tree.acquire(`sibling-${n}`, "sibling"); worker.release(); }
  expect(tree.snapshot("owner").workers.find(w => w.id === "parent")).toMatchObject({ live: false, subtreeLive: true, cleanup: "pending" });
  // Only the owner's own parent record was evicted; sibling churn is not counted.
  expect(tree.snapshot("owner").evictedTerminal).toBe(1);
  child.release(); owner.release(); sibling.release(); await tree.close();
});
