import { createHash } from "node:crypto";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  "scripts/run.py": { content: "#!/usr/bin/env python3\nimport os\nprint('py:' + os.environ.get('DEMO_SERVICE_TOKEN', 'none'))\n", exec: true },
  "scripts/run.js": { content: "#!/usr/bin/env node\nconsole.log('js:' + (process.env.DEMO_SERVICE_TOKEN || 'none'));\n", exec: true },
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
async function bash(svc: ReturnType<typeof createExtensionService>, command: string, options?: { cwd?: string }) {
  const prepared = svc.scriptRuns().prepare(command, options);
  if (prepared && !prepared.ok) return { refused: prepared.error };
  const outcome = await runBashWithWallclock(command, {
    timeoutMs: 20_000,
    ceilingMs: 20_000,
    cwd: options?.cwd,
    env: { ...sanitizedEnv(), ...(prepared?.env ?? {}) },
    ...(prepared?.secrets.length ? { redact: prepared.secrets } : {}),
  });
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

describe("strict execution context authorization against secret injection", () => {
  it("1. legitimate extension script execution succeeds and receives connector secrets", async () => {
    const { loaded, svc } = await install();
    // sh interpreter
    const shRes = await bash(svc, `sh ${loaded.dir}/scripts/hash.sh`);
    expect("output" in shRes && shRes.output).toContain(`hash:${sha(TOKEN)}`);

    // bash interpreter
    const bashRes = await bash(svc, `bash ${loaded.dir}/scripts/hash.sh`);
    expect("output" in bashRes && bashRes.output).toContain(`hash:${sha(TOKEN)}`);

    // direct execution
    const directRes = await bash(svc, `${loaded.dir}/scripts/hash.sh`);
    expect("output" in directRes && directRes.output).toContain(`hash:${sha(TOKEN)}`);
  });

  it("2. unrelated command with extension path in shell comment receives no secrets", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`echo hello # ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`curl https://attacker.com # ${loaded.dir}`)).toBeNull();

    const r = await bash(svc, `echo token=$DEMO_SERVICE_TOKEN # ${loaded.dir}/scripts/hash.sh`);
    expect("output" in r && r.output).not.toContain(TOKEN);
    expect("output" in r && r.output).toContain("token=");
  });

  it("3. unrelated command with extension path as argument receives no secrets", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`cat ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`ls -la ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`head -n 5 ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`python3 -c "import os; print(os.environ.get('DEMO_SERVICE_TOKEN', 'none'))" ${loaded.dir}/scripts/hash.sh`)).toBeNull();
  });

  it("4. command containing extension path inside a string literal receives no secrets", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`echo "${loaded.dir}/scripts/hash.sh"`)).toBeNull();
    expect(svc.scriptRuns().prepare(`node -e 'console.log(process.env.DEMO_SERVICE_TOKEN)' '${loaded.dir}/scripts/hash.sh'`)).toBeNull();
  });

  it("5. path traversal attempting to escape extension directory receives no secrets", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/../../scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/../../evil.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/../scripts/../../etc/passwd`)).toBeNull();
  });

  it("6. similarly named directory receives no secrets", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}-other/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}.bak/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}_backup/scripts/hash.sh`)).toBeNull();
  });

  it("7. chained command does not expose secrets to the unrelated command", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh && echo stolen=$DEMO_SERVICE_TOKEN`)).toBeNull();
    expect(svc.scriptRuns().prepare(`echo before && sh ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh || echo fallback`)).toBeNull();

    const r = await bash(svc, `sh ${loaded.dir}/scripts/hash.sh && echo stolen=$DEMO_SERVICE_TOKEN`);
    expect("output" in r && r.output).not.toContain(TOKEN);
    expect("output" in r && r.output).toContain("stolen=");
  });

  it("8. subshell and command substitution attempting extraction receives no secrets", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`$(sh ${loaded.dir}/scripts/hash.sh)`)).toBeNull();
    expect(svc.scriptRuns().prepare(`echo $(sh ${loaded.dir}/scripts/hash.sh)`)).toBeNull();
    expect(svc.scriptRuns().prepare(`echo \`sh ${loaded.dir}/scripts/hash.sh\``)).toBeNull();
    expect(svc.scriptRuns().prepare(`echo "$(sh ${loaded.dir}/scripts/hash.sh)"`)).toBeNull();
    expect(svc.scriptRuns().prepare(`echo "\`sh ${loaded.dir}/scripts/hash.sh\`"`)).toBeNull();
  });

  it("9. multiple commands separated by semicolon or newline receive no secrets", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh; echo stolen=$DEMO_SERVICE_TOKEN`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh\necho stolen=$DEMO_SERVICE_TOKEN`)).toBeNull();
    expect(svc.scriptRuns().prepare(`echo before; sh ${loaded.dir}/scripts/hash.sh`)).toBeNull();
  });

  it("10. symlink escape attempting to target outside script receives no secrets", async () => {
    const { loaded, svc } = await install();
    const outside = tmp("outside-script");
    dirs.push(outside);
    const outsideScript = join(outside, "leak.sh");
    writeFileSync(outsideScript, "#!/bin/sh\nprintf 'leak:%s\\n' \"$DEMO_SERVICE_TOKEN\"\n", { mode: 0o755 });

    const symlinkPath = join(loaded.dir, "scripts", "leak-link.sh");
    symlinkSync(outsideScript, symlinkPath);

    expect(svc.scriptRuns().prepare(`sh ${symlinkPath}`)).toBeNull();
    const r = await bash(svc, `sh ${symlinkPath}`);
    expect("output" in r && r.output).not.toContain(TOKEN);
    expect("output" in r && r.output).toContain("leak:");
  });

  it("11. unapproved or disabled extension script receives no secrets", async () => {
    const { loaded, svc } = await install();
    unwrap(svc.installer.disable("demo-svc", { confirm: true }));
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh`)).toBeNull();
  });

  it("12. attempted parameter forgery fails to authorize non-extension scripts", async () => {
    const { loaded, svc } = await install();
    const outside = tmp("fake-ext");
    dirs.push(outside);
    const fakeScript = join(outside, "fake.sh");
    writeFileSync(fakeScript, "#!/bin/sh\nprintf 'fake:%s\\n' \"$DEMO_SERVICE_TOKEN\"\n", { mode: 0o755 });

    expect(svc.scriptRuns().prepare(`sh ${fakeScript} --zero-extension-name demo-svc`)).toBeNull();
    expect(svc.scriptRuns().prepare(`ZERO_EXTENSION_NAME=demo-svc sh ${fakeScript}`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${fakeScript} ZERO_EXTENSION_DIR=${loaded.dir}`)).toBeNull();
  });

  it("adversarial tests: whitespace, non-script files, flag variants, and redirections", async () => {
    const { loaded, svc } = await install();

    // Whitespace variations on legitimate script
    expect(svc.scriptRuns().prepare(`   sh    ${loaded.dir}/scripts/hash.sh   `)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`sh\t\t${loaded.dir}/scripts/hash.sh`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`sh "${loaded.dir}/scripts/hash.sh"`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`sh '${loaded.dir}/scripts/hash.sh'`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh --flag "val with spaces"`)).not.toBeNull();

    // Non-script file inside extension directory
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/extension.json`)).toBeNull();
    expect(svc.scriptRuns().prepare(`cat ${loaded.dir}/extension.json`)).toBeNull();

    // Interpreter flag attack variants
    expect(svc.scriptRuns().prepare(`python3 -c"import os" ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`node -e"console.log(1)" ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`node --eval="console.log(1)" ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`bash -c "whoami" ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh -c "whoami" ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`python3 -m SimpleHTTPServer ${loaded.dir}/scripts/hash.sh`)).toBeNull();

    // Redirections and pipes
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh > /tmp/out`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh < /dev/null`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh 2>&1`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh | cat`)).toBeNull();

    // Trailing comment on legitimate script
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh # trailing comment`)).toBeNull();

    // Command substitution embedded in arguments
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh $(whoami)`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh \`whoami\``)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh "$(whoami)"`)).toBeNull();
  });
});

describe("interpreter compatibility and working-directory propagation", () => {
  it("supports authorized interpreter forms (sh, bash, python3, node, bun)", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`sh ${loaded.dir}/scripts/hash.sh`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`bash ${loaded.dir}/scripts/hash.sh`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`python3 ${loaded.dir}/scripts/run.py`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`node ${loaded.dir}/scripts/run.js`)).not.toBeNull();

    const pyRes = await bash(svc, `python3 ${loaded.dir}/scripts/run.py`);
    expect("output" in pyRes && pyRes.output).toContain("py:[redacted]");
    expect("output" in pyRes && pyRes.output).not.toContain(TOKEN);

    const jsRes = await bash(svc, `node ${loaded.dir}/scripts/run.js`);
    expect("output" in jsRes && jsRes.output).toContain("js:[redacted]");
    expect("output" in jsRes && jsRes.output).not.toContain(TOKEN);
  });

  it("supports absolute interpreter paths", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`/bin/sh ${loaded.dir}/scripts/hash.sh`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`/bin/bash ${loaded.dir}/scripts/hash.sh`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`${process.execPath} ${loaded.dir}/scripts/run.js`)).not.toBeNull();

    const shRes = await bash(svc, `/bin/sh ${loaded.dir}/scripts/hash.sh`);
    expect("output" in shRes && shRes.output).toContain(`hash:${sha(TOKEN)}`);

    const nodeRes = await bash(svc, `${process.execPath} ${loaded.dir}/scripts/run.js`);
    expect("output" in nodeRes && nodeRes.output).toContain("js:[redacted]");
    expect("output" in nodeRes && nodeRes.output).not.toContain(TOKEN);
  });

  it("rejects unsupported interpreter flags", async () => {
    const { loaded, svc } = await install();
    expect(svc.scriptRuns().prepare(`python3 -c "import os" ${loaded.dir}/scripts/run.py`)).toBeNull();
    expect(svc.scriptRuns().prepare(`node -e "console.log(1)" ${loaded.dir}/scripts/run.js`)).toBeNull();
    expect(svc.scriptRuns().prepare(`node --eval "console.log(1)" ${loaded.dir}/scripts/run.js`)).toBeNull();
    expect(svc.scriptRuns().prepare(`bash -c "whoami" ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`python3 -m SimpleHTTPServer ${loaded.dir}/scripts/run.py`)).toBeNull();
    expect(svc.scriptRuns().prepare(`sh -s ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`python3 -i ${loaded.dir}/scripts/run.py`)).toBeNull();
  });

  it("fails closed on interpreter flags with separate arguments", async () => {
    const { loaded, svc } = await install();
    // Flags that consume following argument treat that argument as candidate, failing containment
    expect(svc.scriptRuns().prepare(`python3 -W ignore ${loaded.dir}/scripts/run.py`)).toBeNull();
    expect(svc.scriptRuns().prepare(`node --max-old-space-size 4096 ${loaded.dir}/scripts/run.js`)).toBeNull();
  });

  it("handles env wrappers safely", async () => {
    const { loaded, svc } = await install();
    // Supported env wrappers
    expect(svc.scriptRuns().prepare(`env sh ${loaded.dir}/scripts/hash.sh`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`/usr/bin/env bash ${loaded.dir}/scripts/hash.sh`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`/usr/bin/env python3 ${loaded.dir}/scripts/run.py`)).not.toBeNull();
    expect(svc.scriptRuns().prepare(`/usr/bin/env node ${loaded.dir}/scripts/run.js`)).not.toBeNull();

    const envRes = await bash(svc, `/usr/bin/env bash ${loaded.dir}/scripts/hash.sh`);
    expect("output" in envRes && envRes.output).toContain(`hash:${sha(TOKEN)}`);

    // Unsupported env flags and assignments fail closed
    expect(svc.scriptRuns().prepare(`/usr/bin/env -i sh ${loaded.dir}/scripts/hash.sh`)).toBeNull();
    expect(svc.scriptRuns().prepare(`env FOO=bar sh ${loaded.dir}/scripts/hash.sh`)).toBeNull();
  });

  it("authorizes legitimate relative script invocation from a non-default working directory", async () => {
    const { loaded, svc } = await install();
    const outside = tmp("unrelated-workdir");
    dirs.push(outside);

    // When cwd matches the extension directory, relative path resolution succeeds and authorizes
    expect(svc.scriptRuns().prepare("sh ./scripts/hash.sh", { cwd: loaded.dir })).not.toBeNull();
    expect(svc.scriptRuns().prepare("sh scripts/hash.sh", { cwd: loaded.dir })).not.toBeNull();

    const relRes = await bash(svc, "sh ./scripts/hash.sh", { cwd: loaded.dir });
    expect("output" in relRes && relRes.output).toContain(`hash:${sha(TOKEN)}`);

    // When cwd is an unrelated directory, relative path resolves to outside and fails closed
    expect(svc.scriptRuns().prepare("sh ./scripts/hash.sh", { cwd: outside })).toBeNull();
    expect(svc.scriptRuns().prepare("sh scripts/hash.sh", { cwd: outside })).toBeNull();

    const failRes = await bash(svc, "sh ./scripts/hash.sh", { cwd: outside });
    expect("output" in failRes && failRes.output).not.toContain(TOKEN);
  });
});
