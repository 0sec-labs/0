import { describe, it, expect } from "vitest";
import {
  CloudClient,
  CloudUnauthorizedError,
  CloudForbiddenError,
  CloudNetworkError,
  CloudError,
} from "./client.js";
import type { CreditAccount } from "./client.js";

const SECRET = "S3CR3T_CLOUD_TOKEN_DO_NOT_LEAK_42";
const HOST = "https://app.example.com";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function validUsageAccount(overrides?: Partial<CreditAccount>): CreditAccount {
  return {
    schemaVersion: "usage-v2",
    snapshotAt: "2026-09-18T12:00:00Z",
    scope: { orgId: "org_test123" },
    state: "ready",
    reason: null,
    plan: { id: "pro", name: "Pro", monthlyPriceUsd: "39.00" },
    included: { state: "active", usedPercent: 45.5, resetsAt: "2026-10-01T00:00:00.000Z" },
    prepaid: { balanceUsd: "123.45", fallbackEnabled: true },
    canManageBilling: true,
    admission: { eligible: true, reason: null },
    ...overrides,
  };
}

describe("CloudClient.pingHealth — auth + headers", () => {
  it("sends Bearer auth, Accept, and User-Agent headers", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return jsonResponse({ status: "ok" });
    }) as typeof fetch;

    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    const res = await client.pingHealth();
    expect(res.status).toBe("ok");

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(`${HOST}/health`);
    const headers = (captured!.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers.Accept).toBe("application/json");
    expect(headers["User-Agent"]).toMatch(/^@0\/cli\//);
  });
  it.each(["https://cloud.0.ai", "https://cloud.0.security"])(
    "uses the hosted API health endpoint for %s",
    async (host) => {
      let url = "";
      const fetchImpl = (async (input: string | URL | Request) => {
        url = String(input);
        return jsonResponse({ status: "ok" });
      }) as typeof fetch;

      await new CloudClient({ host, token: SECRET, fetchImpl }).pingHealth();
      expect(url).toBe(`${host}/api/health`);
    },
  );
});

describe("CloudClient.deleteJson", () => {
  it("treats a 204 No Content delete as success without parsing a body", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;

    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    await expect(client.deleteJson("/api/scan-schedules/x")).resolves.toBeUndefined();
  });

  it("still parses a JSON body when the delete returns one", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ deleted: true })) as typeof fetch;

    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    await expect(client.deleteJson("/api/scan-schedules/x")).resolves.toEqual({
      deleted: true,
    });
  });
});


describe("CloudClient.pingHealth — error mapping", () => {
  it("throws CloudUnauthorizedError on 401", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    await expect(client.pingHealth()).rejects.toBeInstanceOf(CloudUnauthorizedError);
  });

  it("throws CloudForbiddenError on 403", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    await expect(client.pingHealth()).rejects.toBeInstanceOf(CloudForbiddenError);
  });

  it("throws generic CloudError on 5xx", async () => {
    const fetchImpl = (async () => new Response("server boom", { status: 503 })) as typeof fetch;
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    let caught: unknown;
    try {
      await client.pingHealth();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CloudError);
    expect((caught as CloudError).status).toBe(503);
  });

  it("throws CloudNetworkError on fetch rejection", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    await expect(client.pingHealth()).rejects.toBeInstanceOf(CloudNetworkError);
  });
});

describe("CloudClient — token never leaks", () => {
  const SECRET_RE = new RegExp(SECRET.replace(/[+/=]/g, (c) => `\\${c}`));

  it("401 error message does not contain the token", async () => {
    const fetchImpl = (async () => new Response("body", { status: 401 })) as typeof fetch;
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    let caught: unknown;
    try {
      await client.pingHealth();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(SECRET_RE);
  });

  it("network error message does not contain the token even if interpolated", async () => {
    const fetchImpl = (async () => {
      // Simulate a hostile/leaky network layer that includes auth in its error.
      throw new Error(`TLS handshake failed (auth was Bearer ${SECRET})`);
    }) as typeof fetch;
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl });
    let caught: unknown;
    try {
      await client.pingHealth();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CloudNetworkError);
    expect((caught as Error).message).not.toMatch(SECRET_RE);
    expect((caught as Error).message).toContain("[REDACTED]");
  });
});

describe("CloudClient credit account boundary", () => {
  it("rejects legacy or malformed schemas, preserving auth errors", async () => {
    const account = validUsageAccount();
    const malformed = [
      null,
      { ...account, schemaVersion: "credits-v1" },
      { ...account, schemaVersion: "usage-v1" },
      { ...account, prepaid: { ...account.prepaid, balanceUsd: 10 } },    // number, not string
      { ...account, prepaid: { ...account.prepaid, balanceUsd: "not-an-amount" } },
      { ...account, prepaid: { ...account.prepaid, fallbackEnabled: "no" as unknown as boolean } },
      { ...account, included: { ...account.included, usedPercent: "50" as unknown as number } },
      { ...account, included: { ...account.included, usedPercent: 150 } },  // out of range
      { ...account, included: { ...account.included, resetsAt: "not-a-date" } },
      { ...account, canManageBilling: "yes" as unknown as boolean },
      { ...account, admission: { eligible: "yes" as unknown as boolean, reason: null } },
      { ...account, plan: { ...account.plan, id: "unknownTier" } },
      { ...account, scope: { orgId: 42 as unknown as string } },
      { ...account, snapshotAt: "yesterday" },
    ];
    for (const payload of malformed) {
      const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => jsonResponse(payload) });
      await expect(client.getInferenceAccount(), `expected null for ${JSON.stringify(payload)}`).resolves.toBeNull();
    }
  });

  it("distinguishes unsupported account data from authentication failure", async () => {
    // null body: recognised HTTP 200 but payload is null
    const nullBody = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => jsonResponse(null) });
    await expect(nullBody.getInferenceAccount()).resolves.toBeNull();

    // legacy credits-v1: recognised HTTP 200 but unsupported schema
    const legacy = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => jsonResponse({ ...validUsageAccount(), schemaVersion: "credits-v1" }) });
    await expect(legacy.getInferenceAccount()).resolves.toBeNull();

    // auth rejection still throws
    for (const [status, error] of [[401, CloudUnauthorizedError], [403, CloudForbiddenError]] as const) {
      const denied = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => new Response(null, { status }) });
      await expect(denied.getInferenceAccount()).rejects.toBeInstanceOf(error);
    }
  });

  it("keeps unavailable credit state distinct from a zero balance", async () => {
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(validUsageAccount({
        state: "unavailable", reason: "billing_unavailable",
        plan: { id: null, name: null, monthlyPriceUsd: null },
        included: { state: "unavailable", usedPercent: null, resetsAt: null },
        prepaid: { balanceUsd: null, fallbackEnabled: false },
        canManageBilling: false,
        admission: { eligible: false, reason: "billing_unavailable" },
      })),
    });
    const account = await client.getInferenceAccount();
    expect(account?.state).toBe("unavailable");
    expect(account?.included.usedPercent).toBeNull();
    expect(account?.prepaid.balanceUsd).toBeNull();
  });

  it("preserves exact decimal strings while excluding private accounting", async () => {
    const privateValue = "PRIVATE-SUPPLIER-ACCOUNTING";
    const payload = JSON.parse(JSON.stringify(validUsageAccount()), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, supplierInternal: privateValue } : value,
    );
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => jsonResponse(payload) });
    const account = await client.getInferenceAccount();
    expect(account?.prepaid.balanceUsd).toBe("123.45");
    expect(account?.included.usedPercent).toBe(45.5);
    expect(account?.plan.monthlyPriceUsd).toBe("39.00");
    expect(JSON.stringify(account)).not.toContain(privateValue);
  });

  it("preserves admission ineligibility and reason", async () => {
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(validUsageAccount({
        state: "ready", reason: null,
        plan: { id: null, name: null, monthlyPriceUsd: null },
        included: { state: "exhausted", usedPercent: 100, resetsAt: "2026-10-01T00:00:00.000Z" },
        prepaid: { balanceUsd: "0.00", fallbackEnabled: false },
        canManageBilling: true,
        admission: { eligible: false, reason: "prepaid_disabled" },
      })),
    });
    const account = await client.getInferenceAccount();
    expect(account?.admission.eligible).toBe(false);
    expect(account?.admission.reason).toBe("prepaid_disabled");
  });

  it("roundtrips ready eligible account with plan and included percent", async () => {
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(validUsageAccount()),
    });

    const account = await client.getInferenceAccount();
    expect(account).not.toBeNull();
    expect(account!.state).toBe("ready");
    expect(account!.admission.eligible).toBe(true);
    expect(account!.plan.id).toBe("pro");
    expect(account!.included.usedPercent).toBeCloseTo(45.5);
    expect(account!.prepaid.balanceUsd).toBe("123.45");
  });
});

describe("gateway error codes", () => {
  const HOST2 = "https://cloud.0.security";
  const SECRET2 = "tok";
  const gate = (status: number, code: string) =>
    (async () => new Response(JSON.stringify({ error: { code } }), {
      status, headers: { "content-type": "application/json" },
    })) as typeof fetch;

  it("threads inference_disabled (503) through CloudError.code", async () => {
    const client = new CloudClient({ host: HOST2, token: SECRET2, fetchImpl: gate(503, "inference_disabled") });
    await expect(client.getInferenceAccount()).rejects.toMatchObject({
      name: "CloudError", status: 503, code: "inference_disabled",
    });
  });

  it("threads insufficient_funds (402) through CloudError.code", async () => {
    const client = new CloudClient({ host: HOST2, token: SECRET2, fetchImpl: gate(402, "insufficient_funds") });
    await expect(client.getInferenceModels()).rejects.toMatchObject({
      name: "CloudError", status: 402, code: "insufficient_funds",
    });
  });
});