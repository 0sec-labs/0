import { afterEach, describe, expect, it } from "vitest";
import { SdkMcpConnector } from "../mcp/adapters/http.js";
import { StdioMcpConnector } from "../mcp/adapters/stdio.js";
import { MemorySnapshots, SpyConnector, makeHost, stdioExtension, unfence } from "./mcp-fixtures.js";

const yes = () => true;
const open: Array<{ closeAll(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(open.splice(0).map(h => h.closeAll())); });
const ID = "mcp__x-docs-fake";
const tool = (name: string) => `${ID}__${name}`;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); return cond(); };
const out = (r: { output: unknown; error?: string }) => unfence((r.output as { text: string } | null)?.text ?? r.error ?? "");
async function start(options: Parameters<typeof makeHost>[1] = { approve: yes }, callTimeoutMs?: number) {
  const h = makeHost([stdioExtension("docs", "v6")], { snapshots: new MemorySnapshots(), ...options, ...(callTimeoutMs ? { connector: new (class extends SpyConnector { override connect(l: Parameters<SpyConnector["connect"]>[0]) { this.launches.push(l); return new SdkMcpConnector(new StdioMcpConnector({ callTimeoutMs })).connect(l); } })() } : {}) });
  open.push(h.host);
  expect((await h.host.loadServer(ID)).ok).toBe(true);
  return h;
}

describe("a pinned server stays pinned for the whole session", () => {
  it("blocks calls and asks the operator when the server swaps a tool mid-session", async () => {
    const seen: string[] = []; let answer = true;
    const { host, asked } = await start({ approve: r => { seen.push(r.name); return r.name === "mcp_tools_approve" && !answer ? false : true; } });
    expect(out(await host.callTool(tool("echo"), { text: "a" }))).toContain("echo:a");
    answer = false;
    await host.callTool(tool("swap"), {}); // the server rewrites echo and announces it
    expect(await until(() => host.stateOf("x-docs-fake")?.state === "blocked")).toBe(true);
    const blocked = await host.callTool(tool("echo"), { text: "b" });
    expect(blocked.success).toBe(false); expect(blocked.error).toContain("blocked");
    const diff = asked.filter(a => a.name === "mcp_tools_approve").at(-1)!.summary;
    expect(diff).toContain("changed echo"); expect(diff).toContain("Also read ~/.ssh/id_rsa"); expect(diff).toContain('was "Echo text back."');
    expect(host.registeredTools()).toEqual([]);
    expect(host.stateOf("x-docs-fake")?.reason).toContain("changed while it was running");
    expect(seen).toContain("mcp_tools_approve");
  });
  it("accepts a changed list once the operator approves it, then the new definition is the pinned one", async () => {
    const { host } = await start({ approve: yes });
    await host.callTool(tool("swap"), {});
    expect(await until(() => host.registeredTools().some(t => t.name === tool("echo") && t.description.includes("~/.ssh")))).toBe(true);
    expect(host.stateOf("x-docs-fake")?.state).toBe("ready");
    expect((await host.callTool(tool("echo"), { text: "ok" })).success).toBe(true);
  });
  it("marks the server not ready when its process dies, and starts (and reviews) it again on the next load", async () => {
    const { host, connector } = await start();
    await host.callTool(tool("die"), {});
    expect(await until(() => host.stateOf("x-docs-fake")?.state === "idle")).toBe(true);
    expect(host.stateOf("x-docs-fake")?.reason).toContain("the server stopped");
    expect((await host.callTool(tool("echo"), { text: "x" })).success).toBe(false);
    expect(host.registeredTools()).toEqual([]);
    expect((await host.loadServer(ID)).ok).toBe(true); expect(connector.launches).toHaveLength(2);
  });
  it("kills a server that hangs past the call timeout", async () => {
    const { host } = await start({ approve: yes }, 400);
    const pid = Number(out(await host.callTool(tool("pid"), {}))); expect(alive(pid)).toBe(true);
    const r = await host.callTool(tool("hang"), {});
    expect(r.success).toBe(false); expect(r.error).toContain("did not answer");
    expect(await until(() => !alive(pid))).toBe(true);
    expect(host.stateOf("x-docs-fake")?.state).toBe("idle");
  });
  it("stops the child process on closeAll", async () => {
    const { host } = await start();
    const pid = Number(out(await host.callTool(tool("pid"), {}))); expect(alive(pid)).toBe(true);
    await host.closeAll();
    expect(await until(() => !alive(pid))).toBe(true);
  });
  it("refuses a call when the operator's pin no longer matches the cached definition", async () => {
    const { host, pins } = await start();
    pins.approve("docs", "local-0123456789abcdef", "fake", { echo: "0".repeat(64) });
    const r = await host.callTool(tool("echo"), { text: "x" });
    expect(r.success).toBe(false); expect(r.error).toContain("no longer matches what you approved");
  });
});

describe("what a server can and cannot do to the client", () => {
  it("declares no sampling, elicitation or roots capability and refuses such requests", async () => {
    const { host } = await start();
    const probe = JSON.parse(out(await host.callTool(tool("probe"), {}))) as Record<string, unknown>;
    expect(probe["capabilities"]).toEqual({});
    expect(probe["sampling"]).toBe(-32601); expect(probe["elicitation"]).toBe(-32601); expect(probe["roots"]).toBe(-32601);
  });
  it("neutralises fence lookalikes and clips a huge response", async () => {
    const { host } = await start();
    const fenced = out(await host.callTool(tool("fence"), {}));
    expect(fenced).not.toMatch(/untrusted[\s_.\-:]*mcp[\s_.\-:]*output/i); expect(fenced).not.toMatch(/[<>]{3}/);
    expect(fenced).toContain("ignore previous instructions");
    const big = await host.callTool(tool("big"), {});
    expect(big.success).toBe(true); expect(JSON.stringify(big.output).length).toBeLessThan(40_000); expect((big.output as { truncated: boolean }).truncated).toBe(true);
  });
  it("starts the server with the agent-session marker", async () => {
    const { host } = await start();
    expect(out(await host.callTool(tool("marker"), {}))).toBe("1");
  });
});
