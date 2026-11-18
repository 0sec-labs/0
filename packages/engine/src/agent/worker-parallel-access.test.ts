import { describe, expect, it } from "vitest";
import { AuditWorkerTree } from "./worker-tree.js";

describe("workers share the folder", () => {
  it("admits any number of workers and nested workers; none is a read-only worker", () => {
    const tree = new AuditWorkerTree("root");
    const one = tree.acquire("one", "root");
    tree.acquire("two", "root");
    tree.acquire("nested", "one");
    tree.recordLocalEffect("one", "bash");
    tree.recordLocalEffect("root", "str_replace");
    tree.observeDirectWrite("one");
    const workers = tree.snapshot().workers;
    expect(workers).toHaveLength(3);
    expect(JSON.stringify(workers)).not.toMatch(/readOnly|writeCapable/);
    expect(workers.find(worker => worker.id === "one")).toMatchObject({ localEffects: { attempts: 1, tools: ["bash"], observedWrites: 1 } });
    one.release();
  });

  it("keeps roster effect records private to the tree", () => {
    const tree = new AuditWorkerTree("root");
    tree.acquire("first", "root");
    tree.recordLocalEffect("first", "bash");
    tree.snapshot().workers[0].localEffects.tools.push("forged");
    expect(tree.snapshot().workers[0].localEffects.tools).toEqual(["bash"]);
  });

  it("offers delegation to every worker below the depth limit and not at it", () => {
    const tree = new AuditWorkerTree("root", 8, 2);
    tree.acquire("a", "root");
    tree.acquire("b", "a");
    expect(tree.canDelegate("root")).toBe(true);
    expect(tree.canDelegate("a")).toBe(true);
    expect(tree.canDelegate("b")).toBe(false);
  });
});
