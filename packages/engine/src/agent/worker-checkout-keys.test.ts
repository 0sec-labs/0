import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ToolExecutor } from "./tools.js";

it("guards actual implicit/scoped/shell roots, deduplicating symlink aliases", async () => {
  const temp = mkdtempSync(join(tmpdir(), "0-worker-checkout-keys-"));
  const root = join(temp, "root"); mkdirSync(root);
  const alias = join(temp, "alias"); symlinkSync(root, alias);
  const make = (extra = {}) => new ToolExecutor({ scanId: "parent", target: "https://target.test", findings: [], attackResults: [], targetInfo: {}, ...extra });
  const keys = (executor: ToolExecutor) => (executor as unknown as { checkoutKeys(): string[] }).checkoutKeys();
  const implicit = make(); const split = make({ workspaceRoot: alias }); const scoped = make({ scopePath: alias, workspaceRoot: "/not-authority" });
  try {
    const actualCwdKeys = keys(implicit);
    expect(actualCwdKeys).toHaveLength(1);
    expect(keys(split)).toEqual([realpathSync(root), ...actualCwdKeys]);
    expect(keys(scoped)).toEqual([realpathSync(root)]);
    expect(keys(make({ scopePath: root, workspaceRoot: alias }))).toEqual([realpathSync(root)]);
  } finally {
    await Promise.all([implicit.cleanup(), split.cleanup(), scoped.cleanup()]);
    rmSync(temp, { recursive: true, force: true });
  }
});

it("keeps worker management usable after its checkout disappears", async () => {
  const temp = mkdtempSync(join(tmpdir(), "0-worker-missing-checkout-"));
  const executor = new ToolExecutor({ scanId: "parent", target: "https://target.test", findings: [], attackResults: [], targetInfo: {}, scopePath: temp });
  rmSync(temp, { recursive: true });
  try { expect((await executor.execute({ name: "spawn_agent", arguments: { op: "list" } })).success).toBe(true); }
  finally { await executor.cleanup(); }
});
