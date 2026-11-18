import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ToolExecutor } from "./tools.js";

it("keeps worker management usable after its checkout disappears", async () => {
  const temp = mkdtempSync(join(tmpdir(), "0-worker-missing-checkout-"));
  const executor = new ToolExecutor({ scanId: "parent", target: "https://target.test", findings: [], attackResults: [], targetInfo: {}, scopePath: temp });
  rmSync(temp, { recursive: true });
  try { expect((await executor.execute({ name: "spawn_agent", arguments: { op: "list" } })).success).toBe(true); }
  finally { await executor.cleanup(); }
});
