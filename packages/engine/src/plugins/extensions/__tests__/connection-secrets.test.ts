import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_SESSION_ENV } from "../../../shared/agent-session.js";
import { FsConnectionSecrets } from "../adapters/fs-connection-secrets.js";
import { extensionsRoot } from "../adapters/fs-store.js";
import { cleanup, tmp } from "./fixtures.js";

const homes: string[] = [];
const home = () => { const h = tmp("secrets"); homes.push(h); return h; };
const saved = process.env[AGENT_SESSION_ENV];
afterEach(() => { cleanup(...homes.splice(0)); if (saved === undefined) delete process.env[AGENT_SESSION_ENV]; else process.env[AGENT_SESSION_ENV] = saved; });
delete process.env[AGENT_SESSION_ENV];
const mode = (p: string) => statSync(p).mode & 0o777;

describe("FsConnectionSecrets", () => {
  it("writes owner-only: file 0600, directory 0700, and round-trips", () => {
    delete process.env[AGENT_SESSION_ENV];
    const h = home(); const s = new FsConnectionSecrets(h);
    expect(s.write("demo", "DEMO_TOKEN", "value-123456").ok).toBe(true);
    const dir = extensionsRoot(h);
    expect(mode(dir)).toBe(0o700); expect(mode(join(dir, "connections.json"))).toBe(0o600);
    expect(s.read("demo", "DEMO_TOKEN")).toBe("value-123456"); expect(s.has("demo", "OTHER_TOKEN")).toBe(false);
    expect(s.remove("demo", "DEMO_TOKEN").ok).toBe(true); expect(s.has("demo", "DEMO_TOKEN")).toBe(false);
  });

  it("ignores a symlinked connections.json and never writes through it", () => {
    delete process.env[AGENT_SESSION_ENV];
    const h = home(); const dir = extensionsRoot(h); mkdirSync(dir, { recursive: true });
    const target = join(h, "elsewhere.json"); const original = JSON.stringify({ demo: { DEMO_TOKEN: "planted-value" } });
    writeFileSync(target, original); symlinkSync(target, join(dir, "connections.json"));
    const s = new FsConnectionSecrets(h);
    expect(s.read("demo", "DEMO_TOKEN")).toBeUndefined();
    s.write("demo", "DEMO_TOKEN", "new-value-123");
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(s.read("demo", "DEMO_TOKEN")).toBe("new-value-123");
    expect(lstatSync(join(dir, "connections.json")).isSymbolicLink()).toBe(false);
  });

  it("refuses to change a connection from an agent session but still reads", () => {
    delete process.env[AGENT_SESSION_ENV];
    const h = home(); const s = new FsConnectionSecrets(h); s.write("demo", "DEMO_TOKEN", "value-123456");
    process.env[AGENT_SESSION_ENV] = "1";
    expect(s.write("demo", "DEMO_TOKEN", "changed-value")).toMatchObject({ ok: false, error: { code: "agent_session" } });
    expect(s.remove("demo", "DEMO_TOKEN")).toMatchObject({ ok: false, error: { code: "agent_session" } });
    expect(s.read("demo", "DEMO_TOKEN")).toBe("value-123456");
  });
});
