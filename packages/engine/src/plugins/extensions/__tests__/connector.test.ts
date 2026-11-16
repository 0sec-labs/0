import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_EXTENSIONS, FsConnectionSecrets, TokenConnector, createExtensionService, defaultAdapter, listConnectors, parseManifest, unwrap } from "../index.js";
import type { FolderFile } from "../core/files.js";
import { capabilitiesOf, canDoLines } from "../core/capabilities.js";
import { cleanup, makeRepo, tmp, approve } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => { cleanup(...dirs.splice(0)); });
const file = (path: string, content: string): FolderFile => { const bytes = Buffer.from(content); return { path, size: bytes.length, executable: false, bytes }; };
const manifest = (connector: unknown) => parseManifest([file("extension.json", JSON.stringify({ name: "svc", connector }))]);
const base = { service: "chat", auth: "token", env: ["CHAT_NOTIFY_TOKEN"], hosts: ["chat.example.com"], access: { read: ["channels"], write: ["messages"] } };

/** The proof connector: a token connector with a `notify` script. A fixture for tests only; it is not shipped. */
const CHAT_NOTIFY = {
  "extension.json": JSON.stringify({
    name: "chat-notify", version: "1.0.0", description: "Proof connector: sends a message with a token.",
    connector: { service: "chat", title: "Chat", auth: "token", env: ["CHAT_NOTIFY_TOKEN"], hosts: ["chat.example.com"], access: { read: ["channels"], write: ["messages"] }, health: { type: "http", url: "https://chat.example.com/api/auth.test" } },
  }),
  "scripts/notify.sh": { content: "#!/bin/sh\n[ -n \"$CHAT_NOTIFY_TOKEN\" ] || { echo 'not connected' >&2; exit 3; }\nprintf 'notified \"%s\" (token length %s)\\n' \"$1\" \"${#CHAT_NOTIFY_TOKEN}\"\n", exec: true },
};

describe("connector contract in the manifest", () => {
  it("parses auth, methods, env slot, access, health and display", () => {
    const m = manifest({ ...base, title: "Chat", methods: ["token", "oauth-device"], health: { type: "http", url: "https://chat.example.com/auth.test" }, connectLabel: "Connect Chat" });
    expect(m.ok && m.value.connector).toMatchObject({ service: "chat", title: "Chat", auth: "token", methods: ["token", "oauth-device"], env: ["CHAT_NOTIFY_TOKEN"], read: ["channels"], write: ["messages"], connectLabel: "Connect Chat", health: { type: "http" } });
  });
  it("defaults: methods = [auth], title = service, label Connect, health none; `cli` is the old spelling of `cli-login`", () => {
    const m = manifest({ service: "gh", auth: "cli" });
    expect(m.ok && m.value.connector).toMatchObject({ auth: "cli-login", methods: ["cli-login"], title: "gh", connectLabel: "Connect", health: { type: "none" }, env: [] });
  });
  it("rejects: a token connector with no variable, unsafe variable names, methods without auth, health outside the declared hosts or not https", () => {
    for (const bad of [
      { service: "chat", auth: "token" },
      { ...base, env: ["PATH"] }, { ...base, env: ["lowercase"] },
      { ...base, methods: ["oauth-device"] },
      { ...base, health: { type: "http", url: "https://evil.example.net/x" } },
      { ...base, health: { type: "http", url: "http://chat.example.com/x" } },
      { ...base, health: { type: "http", url: "https://u:p@chat.example.com/x" } },
      { ...base, auth: "password" },
    ]) expect(manifest(bad).ok, JSON.stringify(bad)).toBe(false);
  });
  it("the install prompt lines show the declared read and write list and the methods; any change to them changes the capability key", () => {
    const m = manifest({ ...base, title: "Chat" }); if (!m.ok) throw new Error("x");
    const lines = canDoLines(capabilitiesOf(m.value)).join("\n");
    expect(lines).toContain("connects to Chat (token; chat.example.com); reads: channels; writes: messages");
    expect(lines).toContain("receives environment variables: CHAT_NOTIFY_TOKEN");
    const wider = manifest({ ...base, title: "Chat", access: { read: ["channels"], write: ["messages", "files"] } }); if (!wider.ok) throw new Error("x");
    expect(canDoLines(capabilitiesOf(wider.value)).join("\n")).toContain("writes: messages, files");
  });
});

describe("GitHub is a built-in connector extension", () => {
  const github = BUILTIN_EXTENSIONS.find(b => b.name === "github")!;
  it("declares cli-login, device code and token methods with its read/write list; the token never reaches scripts (no env)", () => {
    expect(github.connector).toMatchObject({ service: "github", auth: "cli-login", methods: ["cli-login", "oauth-device", "token"], env: [], health: { type: "adapter" } });
    expect(github.connector!.read).toEqual(expect.arrayContaining(["pull requests", "repository contents"]));
    expect(github.connector!.write).toEqual(["comments on pull requests"]);
    expect(github.canDo.join("\n")).toContain("writes: comments on pull requests");
  });
  it("ships its pull request skill, and the skill exists in the binary", () => {
    expect(github.skills).toEqual(["pr-diff-review"]);
    expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agent", "skills", "techniques", "pr-diff-review.yaml"))).toBe(true);
  });
  it("cannot be removed or replaced by installed code; update says it follows the binary; listing shows it as a connector", async () => {
    const home = tmp("home"); dirs.push(home); const svc = createExtensionService({ home });
    const removed = svc.installer.remove("github"); expect(!removed.ok && removed.error.code).toBe("builtin");
    const updated = await svc.installer.prepareUpdate("github"); expect(!updated.ok && updated.error.message).toMatch(/updates with the 0 binary/);
    expect(svc.overview().rows.find(r => r.name === "github")).toMatchObject({ builtin: true, skills: ["pr-diff-review"], connector: { service: "github" } });
    expect(listConnectors(svc.store, null).map(e => e.extension)).toContain("github");
  });
  it("disabling needs a confirmation and removes it from the connector list", () => {
    const home = tmp("home"); dirs.push(home); const svc = createExtensionService({ home });
    const refused = svc.installer.disable("github"); expect(!refused.ok && refused.error.code).toBe("needs_confirmation");
    unwrap(svc.installer.disable("github", { confirm: true }));
    expect(listConnectors(svc.store, null).find(e => e.extension === "github")?.enabled).toBe(false);
  });
});

describe("proof connector end to end (test fixture, not shipped)", () => {
  const install = async () => {
    const home = tmp("home"); const repo = makeRepo([CHAT_NOTIFY]); dirs.push(home, repo.dir); const svc = createExtensionService({ home });
    const prepared = unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`));
    unwrap(approve(svc, prepared, { enable: { scope: "global" } }));
    return { home, svc, prepared };
  };
  const fetchWith = (status: number, seen: Array<{ url: string; auth: string | null }> = []): typeof fetch => (async (url: URL | string, init?: RequestInit) => { seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") }); return new Response("{}", { status }); }) as typeof fetch;

  it("the prompt shows the declared read/write list and the variable the token fills", async () => {
    const { prepared } = await install();
    expect(prepared.prompt.canDo.join("\n")).toContain("reads: channels; writes: messages");
    expect(prepared.prompt.canDo.join("\n")).toContain("CHAT_NOTIFY_TOKEN");
  });
  it("connects with a token (checked against the declared host only), then `notify` reads the token from its env", async () => {
    const { home, svc } = await install();
    const entry = listConnectors(svc.store, null).find(e => e.extension === "chat-notify")!;
    expect(entry.connector.env).toEqual(["CHAT_NOTIFY_TOKEN"]);
    const seen: Array<{ url: string; auth: string | null }> = [];
    const adapter = defaultAdapter(entry, svc.secrets, fetchWith(200, seen))!;
    expect((await adapter.status()).state).toBe("not-connected");
    const status = await adapter.connectToken!("tok-12345");
    expect(status).toMatchObject({ state: "connected", health: "ok" });
    expect(seen.every(s => s.url === "https://chat.example.com/api/auth.test" && s.auth === "Bearer tok-12345")).toBe(true);
    // The secret file is private and the secret is not in the status.
    const path = join(home, ".0", "extensions", "connections.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(status)).not.toContain("tok-12345");

    const loaded = svc.loadable().extensions.find(e => e.name === "chat-notify")!;
    const env = loaded.env({ PATH: process.env["PATH"], OPENAI_API_KEY: "sk-not-passed" });
    expect(env["CHAT_NOTIFY_TOKEN"]).toBe("tok-12345");
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    const out = execFileSync("sh", [join(loaded.dir, "scripts/notify.sh"), "hello"], { env, encoding: "utf8" });
    expect(out).toBe('notified "hello" (token length 9)\n');
  });
  it("without a connection the script gets no token; a secret filed under another name is never passed", async () => {
    const { svc } = await install();
    const loaded = svc.loadable().extensions.find(e => e.name === "chat-notify")!;
    expect(loaded.env({ PATH: process.env["PATH"] })["CHAT_NOTIFY_TOKEN"]).toBeUndefined();
    expect(spawnSync("sh", [join(loaded.dir, "scripts/notify.sh"), "x"], { env: loaded.env({ PATH: process.env["PATH"] }), encoding: "utf8" }).status).toBe(3);
    svc.secrets.write("chat-notify", "OTHER_TOKEN", "nope");
    expect(svc.loadable().extensions.find(e => e.name === "chat-notify")!.env({ PATH: process.env["PATH"] })["OTHER_TOKEN"]).toBeUndefined();
  });
  it("a rejected token is not saved; a bad shape is refused; disconnect removes it", async () => {
    const { svc } = await install();
    const entry = listConnectors(svc.store, null).find(e => e.extension === "chat-notify")!;
    const rejecting = new TokenConnector("chat-notify", entry.connector, svc.secrets, fetchWith(401));
    expect(await rejecting.connectToken("bad-token")).toMatchObject({ state: "not-connected", health: "rejected" });
    expect(svc.secrets.has("chat-notify", "CHAT_NOTIFY_TOKEN")).toBe(false);
    expect((await rejecting.connectToken("has space")).detail).toMatch(/without spaces/);
    const ok = new TokenConnector("chat-notify", entry.connector, svc.secrets, fetchWith(200));
    await ok.connectToken("good-token");
    expect(svc.secrets.has("chat-notify", "CHAT_NOTIFY_TOKEN")).toBe(true);
    // The service later rejects the stored token: shown as needing attention.
    expect(await new TokenConnector("chat-notify", entry.connector, svc.secrets, fetchWith(403)).status()).toMatchObject({ state: "needs-attention", health: "rejected" });
    await ok.disconnect();
    expect(svc.secrets.has("chat-notify", "CHAT_NOTIFY_TOKEN")).toBe(false);
  });
  it("never sends the token to a host outside the declared list, even if the stored health url were altered", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const decl = { service: "chat", title: "Chat", description: "", category: "Messaging", auth: "token" as const, methods: ["token" as const], env: ["CHAT_NOTIFY_TOKEN"], hosts: ["chat.example.com"], read: [], write: [], connectLabel: "Connect", surface: null, health: { type: "http" as const, url: "https://evil.example.net/x" } };
    const home = tmp("home"); dirs.push(home);
    const secrets = new FsConnectionSecrets(home); secrets.write("x", "CHAT_NOTIFY_TOKEN", "t");
    expect((await new TokenConnector("x", decl, secrets, fetchWith(200, seen)).status()).health).toBe("unknown");
    expect(seen).toEqual([]);
  });
  it("the secret store refuses writes from an agent session", () => {
    const home = tmp("home"); dirs.push(home); const s = new FsConnectionSecrets(home);
    expect(s.write("a", "A_TOKEN", "1").ok).toBe(true);
    process.env["ZERO_AGENT_SESSION"] = "1";
    try { const r = s.write("a", "B_TOKEN", "2"); expect(!r.ok && r.error.code).toBe("agent_session"); expect(s.has("a", "B_TOKEN")).toBe(false); expect(s.remove("a", "A_TOKEN").ok).toBe(false); }
    finally { delete process.env["ZERO_AGENT_SESSION"]; }
    expect(s.read("a", "A_TOKEN")).toBe("1");
  });
});
