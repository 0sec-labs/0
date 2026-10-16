import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveScopedPath } from "../agent/tools/scope-path.js";
import { ToolExecutor } from "../agent/tools.js";
import type { ToolContext } from "../agent/types.js";
import { getScopeEnforcementState, isScopeEnforcementEnabled, withScopeEnforcement } from "./activation.js";
import { getLocalSourceBoundary, withLocalSourceBoundary } from "./local-source-boundary.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "0-mandatory-source-"))); directories.push(root);
  const folder = join(root, "service"); mkdirSync(folder); writeFileSync(join(folder, "inside.ts"), "INSIDE");
  writeFileSync(join(root, "outside.ts"), "OUTSIDE_SECRET"); symlinkSync(join(root, "outside.ts"), join(folder, "linked.ts"));
  const disabled = getScopeEnforcementState(root, root);
  expect(disabled.enabled).toBe(false);
  const ctx = { target: folder, scopePath: folder, role: "review", autonomyMode: "yolo", scanId: "scope-control",
    findings: [], attackResults: [], targetInfo: {} } as ToolContext;
  return { root, folder, disabled, ctx };
}

it("confines canonical paths even while the optional engagement plugin is disabled", () => {
  const f = fixture();
  withScopeEnforcement(f.disabled, () => {
    expect(resolveScopedPath(f.folder, "../outside.ts")).toBe(join(f.root, "outside.ts"));
    withLocalSourceBoundary(f.folder, () => {
      expect(isScopeEnforcementEnabled()).toBe(false);
      expect(resolveScopedPath(f.folder, "inside.ts")).toBe(join(f.folder, "inside.ts"));
      for (const path of ["../outside.ts", join(f.root, "outside.ts"), "linked.ts"]) {
        expect(() => resolveScopedPath(f.folder, path)).toThrow();
      }
      expect(() => resolveScopedPath(f.root, "outside.ts")).toThrow();
    });
    expect(getLocalSourceBoundary()).toBeUndefined(); expect(isScopeEnforcementEnabled()).toBe(false);
  });
});

it("retains a tool executor's folder boundary after async context exit and blocks YOLO widening", async () => {
  const f = fixture();
  const executor = withLocalSourceBoundary(f.folder, () => new ToolExecutor(f.ctx, null));
  await withScopeEnforcement(f.disabled, async () => {
    const inside = await executor.execute({ name: "read_file", arguments: { path: "inside.ts" } });
    expect(inside.success).toBe(true);
    for (const name of ["read_file", "list_files", "search_files"]) {
      const denied = await executor.execute({ name, arguments: { path: "../outside.ts", query: "SECRET" } });
      expect(denied.success).toBe(false); expect(JSON.stringify(denied.output)).not.toContain("OUTSIDE_SECRET");
    }
    const command = await executor.execute({ name: "run_command", arguments: { command: "cat ../outside.ts" } });
    expect(command.success).toBe(false); expect(command.error).toContain("not available in a scoped source audit");
    executor.configureWorkspace(f.root);
    expect((await executor.execute({ name: "read_file", arguments: { path: "outside.ts" } })).success).toBe(false);
    expect(isScopeEnforcementEnabled()).toBe(false);
  });
});
