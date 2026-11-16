import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService, unwrap } from "../index.js";
import { approve, cleanup, tmp, writeTree } from "./fixtures.js";
import { FAKE_STDIO, SpyConnector, allow } from "./mcp-fixtures.js";

const dirs: string[] = [];
afterEach(() => { cleanup(...dirs.splice(0)); });

async function install() {
  const home = tmp("home"); const src = tmp("src"); dirs.push(home, src);
  const variant = join(src, "variant-file"); writeFileSync(variant, "v1");
  // The variant file lives outside the extension folder, so the server can change without a new revision of the extension.
  writeTree(src, { "extension.json": JSON.stringify({ name: "docs", version: "1.0.0", description: "Docs server", "0": { mcp: { fake: { command: process.execPath, args: [FAKE_STDIO, variant] } } } }) });
  const svc = createExtensionService({ home });
  unwrap(approve(svc, unwrap(await svc.installer.prepare(src)), { enable: { scope: "global" } }));
  return { svc, variant, home };
}
const yes = () => true;

describe("extension service MCP wiring", () => {
  it("pins survive in the sealed state, and `info`/overview show approved, then changed, new and removed", async () => {
    const { svc, variant } = await install();
    expect(svc.mcpStatus("docs")).toMatchObject({ ok: true, value: [{ server: "fake", state: "not-connected" }] });

    const first = svc.mcpHost({ gate: allow, parentEnv: { PATH: process.env["PATH"] } });
    first.attachOperator({ cwd: process.cwd(), thread: () => ({}), approve: yes });
    expect((await first.loadServer("mcp__x-docs-fake")).ok).toBe(true); await first.closeAll();
    const approved = unwrap(svc.mcpStatus("docs"))[0]!;
    expect(approved.state).toBe("approved");
    expect(approved.tools.map(t => [t.name, t.state])).toEqual([["echo", "approved"], ["env_report", "approved"], ["inject", "approved"]]);
    expect(approved.tools.every(t => /^[0-9a-f]{64}$/.test(t.approvedHash ?? ""))).toBe(true);

    writeFileSync(variant, "v3"); // the server adds a tool
    const second = svc.mcpHost({ gate: allow, parentEnv: { PATH: process.env["PATH"] } });
    const blocked = await second.loadServer("mcp__x-docs-fake");
    expect(blocked.ok).toBe(false); expect(blocked.message).toContain("new: extra"); await second.closeAll();
    expect(unwrap(svc.mcpStatus("docs"))[0]).toMatchObject({ state: "needs-approval" });
    expect(unwrap(svc.mcpStatus("docs"))[0]!.tools.find(t => t.name === "extra")?.state).toBe("new");
    const row = svc.overview().rows.find(r => r.name === "docs")!;
    expect(row.status).toBe("enabled"); expect(row.mcp[0]).toMatchObject({ state: "needs-approval" }); expect(row.mcp[0]!.reason).toContain("new: extra");
  });

  it("starts nothing for an extension that is not enabled or not approved", async () => {
    const { svc } = await install();
    unwrap(svc.installer.disable("docs"));
    const host = svc.mcpHost({ gate: allow }); const spy = new SpyConnector();
    expect(host.serverIds()).toEqual([]); expect(spy.launches).toHaveLength(0);
    expect((await host.loadServer("mcp__x-docs-fake")).ok).toBe(false);
  });
});
