import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService, unwrap } from "../index.js";
import { runBashWithWallclock } from "../../../agent/tools/exec-helpers.js";
import { sanitizedEnv } from "../../../agent/sanitized-env.js";
import { cleanup, makeRepo, tmp, approve } from "./fixtures.js";
import { FAKE_STDIO, allow, unfence } from "./mcp-fixtures.js";

const dirs: string[] = [];
const hosts: Array<{ closeAll(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(h => h.closeAll())); cleanup(...dirs.splice(0)); });

const TOKEN = "tok-live-4f9a1c7e2b";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const DEMO = {
  "extension.json": JSON.stringify({
    name: "demo-svc", version: "1.0.0", description: "Token connector with a script and an MCP server.",
    "0": { connector: { service: "demo", title: "Demo", auth: "token", env: ["DEMO_SERVICE_TOKEN"], hosts: ["demo.example.com"], access: { read: ["things"], write: [] } }, mcp: { fake: { command: process.execPath, args: [FAKE_STDIO, "v6"], env: { DEMO_SERVICE_TOKEN: "x" } } } },
  }),
  "scripts/hash.sh": { content: "#!/bin/sh\nprintf 'hash:%s\\n' \"$(printf '%s' \"$DEMO_SERVICE_TOKEN\" | shasum -a 256 | cut -d' ' -f1)\"\nprintf 'plain:%s\\n' \"$DEMO_SERVICE_TOKEN\"\nprintf 'other:%s\\n' \"${OPENAI_API_KEY:-unset}\"\n", exec: true },
};

async function install(connect = true) {
  const home = tmp("home"); const repo = makeRepo([DEMO]); dirs.push(home, repo.dir);
  const svc = createExtensionService({ home });
  unwrap(approve(svc, unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { enable: { scope: "global" } }));
  if (connect) unwrap(svc.secrets.write("demo-svc", "DEMO_SERVICE_TOKEN", TOKEN));
  const loaded = svc.loadable().extensions.find(e => e.name === "demo-svc")!;
  return { home, svc, loaded };
}

/** What the bash tool does: ask the port, merge the answer over the sanitised environment, run, mask the secrets. */
async function bash(svc: ReturnType<typeof createExtensionService>, command: string) {
  const prepared = svc.scriptRuns().prepare(command);
  if (prepared && !prepared.ok) return { refused: prepared.error };
  const outcome = await runBashWithWallclock(command, { timeoutMs: 20_000, ceilingMs: 20_000, env: { ...sanitizedEnv(), ...(prepared?.env ?? {}) }, ...(prepared?.secrets.length ? { redact: prepared.secrets } : {}) });
  if (outcome.kind !== "exit") throw new Error(JSON.stringify(outcome));
  return { prepared, output: outcome.combined };
}

describe("a connector's stored token reaches a script and an MCP server, and nowhere else", () => {
  it("fills the declared and approved variable for a script run through bash, never echoes it, and keeps provider keys out", async () => {
    const { loaded, svc } = await install();
    process.env["OPENAI_API_KEY"] = "sk-parent-secret-value";
    try {
      const r = await bash(svc, `sh ${loaded.dir}/scripts/hash.sh`);
      expect("output" in r && r.output).toContain(`hash:${sha(TOKEN)}`);
      expect("output" in r && r.output).toContain("plain:[redacted]");
      expect("output" in r && r.output).toContain("other:unset");
      expect("output" in r && r.output).not.toContain(TOKEN);
      expect("output" in r && r.output).not.toContain("sk-parent-secret-value");
    } finally { delete process.env["OPENAI_API_KEY"]; }
  });
  it("adds nothing for a command that is not a script of the extension, and nothing without a connection", async () => {
    const { svc, loaded } = await install(false);
    expect(svc.scriptRuns().prepare("echo hello")).toBeNull();
    expect(svc.scriptRuns().prepare(`echo ${loaded.dir}-other/x`)).toBeNull();
    const r = await bash(svc, `sh ${loaded.dir}/scripts/hash.sh`);
    expect("output" in r && r.output).toContain(`hash:${sha("")}`);
  });
  it("does not fill the token of a disabled extension", async () => {
    const { svc, loaded } = await install();
    unwrap(svc.installer.disable("demo-svc", { confirm: true }));
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh`)).toBeNull();
  });
  it("refuses to run when the approval does not cover a variable the extension declares", async () => {
    const { svc, loaded } = await install();
    const raw = svc.store.read(); if (!raw.ok) throw new Error("state");
    const narrowed = { ...svc.store, read: () => { const state = structuredClone(raw.value); for (const e of Object.values(state.extensions)) for (const r of Object.values(e.revisions)) r.approvedEnv = []; return { ok: true as const, value: state }; }, revisionPath: svc.store.revisionPath.bind(svc.store), readRevision: svc.store.readRevision.bind(svc.store) } as typeof svc.store;
    const { createScriptRuns } = await import("../script-runs.js");
    const r = createScriptRuns({ store: narrowed, secrets: svc.secrets, projectKey: null }).prepare(`sh ${loaded.dir}/scripts/hash.sh`);
    expect(r).toMatchObject({ ok: false }); expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it("an MCP server receives the token in its environment, and what it echoes back is redacted", async () => {
    const { svc } = await install();
    const host = svc.mcpHost({ gate: allow, parentEnv: { PATH: process.env["PATH"] } });
    hosts.push(host); host.attachOperator({ cwd: process.cwd(), thread: () => ({}), approve: async () => true });
    const id = host.serverIds()[0]!; expect(id).toBe("x-demo-svc-fake");
    expect((await host.loadServer(`mcp__${id}`)).ok).toBe(true);
    const text = (r: { output: unknown }) => unfence((r.output as { text: string }).text);
    expect(text(await host.callTool(`mcp__${id}__hash`, {}))).toBe(sha(TOKEN));
    expect(text(await host.callTool(`mcp__${id}__echo`, { text: `leak ${TOKEN}` }))).toBe("echo:leak [redacted]");
    expect(text(await host.callTool(`mcp__${id}__marker`, {}))).toBe("1");
  });
  it("an MCP server gets no token when the connection does not exist or the parent environment is all that is set", async () => {
    const { svc } = await install(false);
    const host = svc.mcpHost({ gate: allow, parentEnv: { PATH: process.env["PATH"], OTHER_TOKEN: "x-parent" } });
    hosts.push(host); host.attachOperator({ cwd: process.cwd(), thread: () => ({}), approve: async () => true });
    await host.loadServer("mcp__x-demo-svc-fake");
    expect(unfence(((await host.callTool("mcp__x-demo-svc-fake__hash", {})).output as { text: string }).text)).toBe(sha(""));
  });
});
