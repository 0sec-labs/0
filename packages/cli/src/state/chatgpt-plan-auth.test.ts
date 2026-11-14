import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { loginSiwc, refreshSiwcProfile, SIWC_ISSUER, SIWC_SCOPES, siwcMetadata, validateSiwcTokens, type SiwcProfile } from "./chatgpt-plan-auth.js";
let keys: Awaited<ReturnType<typeof generateKeyPair>>, jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => { keys = await generateKeyPair("RS256"); jwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" }; });
export async function signedToken(nonce?: string, changes: Record<string, unknown> = {}) {
  return new SignJWT({ sub: "subject-a", email: "person@example.test", ...(nonce ? { nonce } : {}), ...changes }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(typeof changes.iss === "string" ? changes.iss : SIWC_ISSUER).setAudience(typeof changes.aud === "string" ? changes.aud : "oaiapp_test").setIssuedAt(typeof changes.iat === "number" ? changes.iat : undefined).setExpirationTime(typeof changes.exp === "number" ? changes.exp : "1h").sign(keys.privateKey);
}
const metadata = { issuer: SIWC_ISSUER, token_endpoint: `${SIWC_ISSUER}/api/accounts/oauth/token`, jwks_uri: `${SIWC_ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${SIWC_ISSUER}/api/accounts/oauth/revoke` };
function harness(changes: { claims?: Record<string, unknown>; scope?: string; clientId?: string; beforeCallback?: (url: URL) => Promise<void> } = {}) {
  let authorize!: URL;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("openid-configuration")) return Response.json(metadata);
    if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("oauth/token")) return Response.json({ id_token: await signedToken(authorize.searchParams.get("nonce")!, changes.claims), access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", expires_in: 3600, scope: changes.scope ?? SIWC_SCOPES.join(" ") });
    throw new Error("unexpected endpoint");
  });
  return { fetch, calls, onAuthorize: async (value: string) => {
    authorize = new URL(value); await changes.beforeCallback?.(authorize);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!); callback.searchParams.set("code", "private-code"); callback.searchParams.set("client_id", changes.clientId ?? "oaiapp_test");
    expect((await globalThis.fetch(callback)).status).toBe(200);
  }, authorize: () => authorize };
}
describe("0-owned native ChatGPT registration protocol", () => {
  it("registers under 0's actual name and exchanges only the issued client with PKCE/state/nonce", async () => {
    const f = harness({ beforeCallback: async auth => { const wrong = new URL(auth.searchParams.get("redirect_uri")!); wrong.searchParams.set("state", "wrong"); expect((await fetch(wrong)).status).toBe(400); } });
    const profile = await loginSiwc({ ...f, hostId: "urn:uuid:00000000-0000-4000-8000-000000000001" });
    expect(profile).toMatchObject({ clientId: "oaiapp_test", subject: "subject-a", scopes: SIWC_SCOPES, status: "connected" });
    expect(f.authorize().searchParams.get("agent_name_hint")).toBe("0"); expect(f.authorize().searchParams.get("client_id")).toBe("dynamic_agent_client");
    const exchange = f.calls.find(c => c.url.endsWith("oauth/token"))!;
    const body = new URLSearchParams(String(exchange.init?.body)); expect(body.get("client_id")).toBe("oaiapp_test"); expect(body.get("code_verifier")!.length).toBeGreaterThan(43);
    expect(body.get("redirect_uri")).toBe(f.authorize().searchParams.get("redirect_uri")); expect(body.get("resource")).toBe("https://api.openai.com/v1");
    expect(f.calls.every(call => call.init?.redirect === "error")).toBe(true);
  });
  it.each([{ nonce: "wrong" }, { sub: "" }, { iat: Math.floor(Date.now()/1000) + 3600 }, { azp: "wrong-client" }, { aud: "other-client" }, { iss: "https://other.example" }, { exp: Math.floor(Date.now()/1000)-1 }])("rejects invalid verified identity binding %j", async claims => {
    const f = harness({ claims }); await expect(loginSiwc({ ...f, hostId: "urn:uuid:00000000-0000-4000-8000-000000000001" })).rejects.toThrow(/identity/);
  });
  it("does not mistake identity-only authorization for plan entitlement", async () => {
    const f = harness({ scope: "openid profile email" }); const profile = await loginSiwc({ ...f, hostId: "urn:uuid:00000000-0000-4000-8000-000000000001" });
    expect(profile.scopes).not.toContain("chatgpt.tokens.use.direct");
  });
  it("rejects a placeholder client in the callback before token exchange", async () => {
    const f = harness({ clientId: "dynamic_agent_client" }); await expect(loginSiwc({ ...f, hostId: "urn:uuid:00000000-0000-4000-8000-000000000001" })).rejects.toThrow("registration");
    expect(f.calls).toHaveLength(0);
  });
  it("rejects a tampered signature rather than trusting decoded token claims", async () => {
    const token = await signedToken("nonce"); const parts = token.split("."); parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ keys: [jwk] }));
    await expect(validateSiwcTokens({ id_token: parts.join(".") }, "oaiapp_test", { token: "unused", jwks: `${SIWC_ISSUER}/keys`, revoke: "unused" }, { fetch }, undefined, { nonce: "nonce" })).rejects.toThrow("verification failed");
  });
  it("cancels the callback listener before network exchange", async () => {
    const controller = new AbortController(); let callback!: string;
    await expect(loginSiwc({ hostId: "urn:uuid:00000000-0000-4000-8000-000000000001", signal: controller.signal, onAuthorize: value => { callback = new URL(value).searchParams.get("redirect_uri")!; controller.abort(); } })).rejects.toThrow(/cancelled|abort/i);
    await expect(fetch(callback)).rejects.toThrow();
  });
  it("cancellation closes the callback even if the browser opener never resolves", async () => {
    const controller = new AbortController(); let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const work = loginSiwc({ hostId: "urn:uuid:00000000-0000-4000-8000-000000000001", signal: controller.signal, onAuthorize: () => { ready(); return new Promise(() => undefined); } });
    await started; controller.abort(); await expect(work).rejects.toThrow(/cancelled|abort/i);
  });
  it("rejects untrusted OIDC endpoint metadata without credential requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ...metadata, token_endpoint: "https://attacker.example/token" }));
    await expect(siwcMetadata({ fetch })).rejects.toThrow("untrusted endpoint"); expect(fetch).toHaveBeenCalledOnce();
  });
  it("accepts omitted refresh ID/refresh tokens only for a previously verified connection", async () => {
    const prior: SiwcProfile = { id: "p", clientId: "oaiapp_test", subject: "subject-a", issuer: SIWC_ISSUER, scopes: SIWC_SCOPES, idToken: await signedToken(), accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0, status: "connected" };
    const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith("openid-configuration") ? Response.json(metadata) : String(input).endsWith("jwks.json") ? Response.json({ keys: [jwk] }) : Response.json({ access_token: "new-access", expires_in: 3600, token_type: "Bearer" }));
    const checkpoint = vi.fn(async () => undefined); const result = await refreshSiwcProfile(prior, { fetch }, undefined, checkpoint);
    expect(result).toMatchObject({ accessToken: "new-access", refreshToken: "old-refresh", subject: "subject-a" }); expect(checkpoint).toHaveBeenCalledOnce();
    const md = await siwcMetadata({ fetch }); await expect(validateSiwcTokens({ access_token: "new-access" }, prior.clientId, md, { fetch })).rejects.toThrow();
  });
});
