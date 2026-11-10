import { describe, expect, it } from "vitest";
import { AuditWorkerTree } from "./worker-tree.js";

const writer = { workspace: { key: "/checkout", writeCapable: true, readOnly: false } };
const reader = { workspace: { key: "/checkout", writeCapable: false, readOnly: true } };
describe("owned-tree checkout admission", () => {
  it("reserves queued/parked writers until cleanup and permits isolated roots", () => {
    const tree = new AuditWorkerTree("root");
    const lease = tree.acquire("one", "root", writer);
    expect(() => tree.acquire("two", "root", writer)).toThrow("Shared checkout is busy");
    tree.observeLifecycle({ agent_id: "one", status: "parked" });
    expect(() => tree.acquire("nested", "one", writer)).toThrow("Shared checkout is busy");
    tree.acquire("isolated", "root", { workspace: { ...writer.workspace, key: "/other" } }).release();
    lease.release();
    tree.acquire("two", "root", writer).release();
  });
  it("excludes parent writes and admits no child writer during an existing parent dispatch", () => {
    const tree = new AuditWorkerTree("root");
    const release = tree.beginLocalMutation("root", "/checkout", "bash");
    expect(() => tree.acquire("child", "root", writer)).toThrow("Shared checkout is busy");
    release();
    const child = tree.acquire("child", "root", writer);
    expect(() => tree.beginLocalMutation("root", "/checkout", "str_replace")).toThrow("Shared checkout is busy");
    const end = tree.beginLocalMutation("child", "/checkout", "str_replace");
    tree.observeDirectWrite("child");
    end();
    child.release();
    expect(tree.snapshot().workers[0]).toMatchObject({ effects: "unknown", localEffects: { attempts: 1, tools: ["str_replace"], observedWrites: 1 } });
  });
  it("preserves inherited read-only restriction and allows parallel readers", () => {
    const tree = new AuditWorkerTree("root");
    tree.acquire("reader", "root", reader);
    tree.acquire("other", "root", reader);
    expect(() => tree.acquire("escalation", "reader", writer)).toThrow("read-only");
    expect(() => tree.beginLocalMutation("reader", "/checkout", "bash")).toThrow("Read-only");
    expect(tree.snapshot().workers).toHaveLength(2);
  });
  it("admits multiple guarded roots atomically and protects private lease metadata", () => {
    const tree = new AuditWorkerTree("root");
    const workspace = { ...writer.workspace, guardedKeys: ["/checkout", "/implicit-cwd"] };
    const lease = tree.acquire("first", "root", { workspace });
    workspace.guardedKeys.length = 0;
    const publicWorker = tree.snapshot().workers[0];
    publicWorker.workspace!.guardedKeys!.length = 0;
    expect(() => tree.acquire("overlap", "root", { workspace: { ...writer.workspace, key: "/implicit-cwd" } })).toThrow("Shared checkout is busy");
    expect(() => tree.acquire("atomic", "root", { workspace: { ...writer.workspace, key: "/free", guardedKeys: ["/free", "/checkout"] } })).toThrow();
    tree.acquire("not-leaked", "root", { workspace: { ...writer.workspace, key: "/free" } }).release();
    lease.release();
    const record = tree.snapshot().workers.find(worker => worker.id === "first")!;
    record.localEffects.tools.push("forged");
    expect(tree.snapshot().workers.find(worker => worker.id === "first")!.localEffects.tools).toEqual([]);
  });

});
