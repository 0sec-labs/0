import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService, type ConnectorAuthPort, type ConnectorStatus } from "@0/engine";
import { handleConnectorRequest } from "./connector-routes.js";
import { describeConsoleAudit } from "./audit.js";
import { isPrivilegedOperatorRoute, privilegedRouteDenial } from "./privileged-routes.js";
import { ServerModeGuard } from "./server-mode.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const setup = () => { const home = mkdtempSync(join(tmpdir(), "conn-route-")); homes.push(home); return createExtensionService({ home }); };
const connected: ConnectorStatus = { state: "connected", account: "ada", detail: "via GitHub CLI", health: "ok" };
const fakeGithub = (calls: string[]): ConnectorAuthPort => ({ status: async () => connected, signIn: async () => { calls.push("sign-in"); return connected; }, connectToken: async t => { calls.push(`token:${t.length}`); return connected; }, cancel: async () => connected });

describe("connector routes", () => {
  it("lists the built-in github connector with its contract and live status from the adapter", async () => {
    const svc = setup(); const calls: string[] = [];
    const r = await handleConnectorRequest(svc, { github: fakeGithub(calls) }, "extensions/connectors", "GET", undefined);
    const rows = (r!.data as { connectors: Array<{ extension: string; builtin: boolean; connector: { write: string[]; methods: string[] }; status: ConnectorStatus }> }).connectors;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ extension: "github", builtin: true, connector: { methods: ["cli-login", "oauth-device", "token"], write: ["comments on pull requests"] }, status: { state: "connected", account: "ada" } });
  });
  it("connect and sign-in go through the adapter; the token is never echoed", async () => {
    const svc = setup(); const calls: string[] = []; const hosted = { github: fakeGithub(calls) };
    const c = await handleConnectorRequest(svc, hosted, "extensions/connectors/github/connect", "POST", { token: "github_pat_x" });
    expect(c!.status).toBe(200); expect(JSON.stringify(c!.data)).not.toContain("github_pat_x");
    expect((await handleConnectorRequest(svc, hosted, "extensions/connectors/github/sign-in", "POST", {}))!.status).toBe(202);
    expect(calls).toEqual(["token:12", "sign-in"]);
  });
  it("refuses a bad body, an unknown connector and a disabled one", async () => {
    const svc = setup(); const hosted = { github: fakeGithub([]) };
    expect((await handleConnectorRequest(svc, hosted, "extensions/connectors/github/connect", "POST", { token: "" }))!.status).toBe(400);
    expect((await handleConnectorRequest(svc, hosted, "extensions/connectors/github/connect", "POST", { token: "x", extra: 1 }))!.status).toBe(400);
    expect((await handleConnectorRequest(svc, hosted, "extensions/connectors/nope/connect", "POST", { token: "x" }))!.status).toBe(404);
    svc.installer.disable("github", { confirm: true });
    expect((await handleConnectorRequest(svc, hosted, "extensions/connectors/github/connect", "POST", { token: "x" }))!.status).toBe(409);
    const list = (await handleConnectorRequest(svc, hosted, "extensions/connectors", "GET", undefined))!.data as { connectors: Array<{ enabled: boolean; status: ConnectorStatus }> };
    expect(list.connectors[0]).toMatchObject({ enabled: false, status: { state: "unavailable" } });
  });
  it("ignores other routes; mutations are privileged and audited without the token", () => {
    expect(handleConnectorRequest(setup(), {}, "extensions", "GET", undefined)).resolves.toBeNull();
    expect(isPrivilegedOperatorRoute("/api/console/extensions/connectors/github/connect", "POST")).toBe(true);
    expect(isPrivilegedOperatorRoute("/api/console/extensions/connectors", "GET")).toBe(false);
    const audit = describeConsoleAudit("extensions/connectors/github/connect", "POST", { token: "secret-value" });
    expect(audit).toMatchObject({ action: "extension.connector.connect", subject: "github" });
    expect(JSON.stringify(audit)).not.toContain("secret-value");
  });
});

describe("connector route authority", () => {
  const urls = ["connect", "sign-in", "cancel", "disconnect"].map(a => `/api/console/extensions/connectors/github/${a}`);
  it("refuses the engine bearer on every connector mutation but lets it read", () => {
    for (const url of urls) expect(privilegedRouteDenial(url, "POST", { engineRequest: true, teamEnabled: false })).toMatchObject({ status: 403, data: { code: "browser_only" } });
    expect(privilegedRouteDenial("/api/console/extensions/connectors", "GET", { engineRequest: true, teamEnabled: false })).toBeNull();
  });
  it("refuses viewers and members in team mode, allows the owner and a solo browser", () => {
    for (const url of urls) {
      for (const role of ["viewer", "member", undefined]) expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true, ...(role ? { role } : {}) })).toMatchObject({ status: 403 });
      expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: true, role: "owner" })).toBeNull();
      expect(privilegedRouteDenial(url, "POST", { engineRequest: false, teamEnabled: false })).toBeNull();
    }
  });
  it("refuses a cross-site mutation without same-origin evidence (CSRF)", () => {
    const g = new ServerModeGuard({ allowedHosts: ["0.example.com"], trustedProxies: [], accessToken: "t".repeat(40) });
    const ctx = { authority: "0.example.com", https: false, clientIp: "198.51.100.7", viaTrustedProxy: false };
    const req = (headers: Record<string, string>) => ({ method: "POST", url: urls[0], headers, socket: { remoteAddress: "203.0.113.9" } }) as never;
    expect(g.csrfDenial(req({}), ctx)).toMatch(/Origin/);
    expect(g.csrfDenial(req({ "sec-fetch-site": "cross-site" }), ctx)).toMatch(/Origin/);
    expect(g.csrfDenial(req({ "sec-fetch-site": "same-origin" }), ctx)).toBeUndefined();
    expect(g.csrfDenial(req({ origin: "http://0.example.com" }), ctx)).toBeUndefined();
  });
  it("stores nothing when the GitHub adapter rejects a token", async () => {
    const svc = setup();
    const rejecting: ConnectorAuthPort = { status: async () => connected, connectToken: async () => { throw Object.assign(new Error("GitHub did not accept this token."), { status: 422 }); } };
    const r = await handleConnectorRequest(svc, { github: rejecting }, "extensions/connectors/github/connect", "POST", { token: "github_pat_bad" });
    expect(r!.status).toBe(422); expect(JSON.stringify(r!.data)).not.toContain("github_pat_bad");
    expect(svc.secrets.has("github", "GITHUB_TOKEN")).toBe(false);
  });
});
