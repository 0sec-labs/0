import { describe, it, expect } from "vitest";
import {
  CloudClient,
  CloudUnauthorizedError,
  CloudForbiddenError,
  CloudNetworkError,
  CloudError,
} from "./client.js";
import type { UsageAccount } from "./client.js";

const SECRET = "S3CR3T_CLOUD_TOKEN_DO_NOT_LEAK_42";
const HOST = "https://app.example.com";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function validUsageAccount(overrides?: Partial<UsageAccount>): UsageAccount {
  return {
    schemaVersion: "usage-v2",
    snapshotAt: "2026-09-18T12:00:00Z",
    scope: { orgId: "org_test123" },
    state: "ready",
    reason: null,
    plan: { id: "pro", name: "Pro", monthlyPriceUsd: "39.00" },
    included: { state: "active", usedPercent: 25, resetsAt: "2026-10-18T00:00:00Z" },
    prepaid: { balanceUsd: "123456789.012345678", fallbackEnabled: false },
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

describe("CloudClient usage account boundary", () => {
  it("rejects legacy or malformed money, percentage and reset values", async () => {
    const account = validUsageAccount();
    const malformed = [
      null,
      { ...account, schemaVersion: "credits-v1" },
      { ...account, prepaid: { ...account.prepaid, balanceUsd: 10 } },
      { ...account, prepaid: { ...account.prepaid, balanceUsd: "-1" } },
      { ...account, included: { ...account.included, usedPercent: 101 } },
      { ...account, included: { ...account.included, resetsAt: "not-a-date" } },
    ];
    for (const payload of malformed) {
      const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => jsonResponse(payload) });
      expect(await client.getInferenceAccount()).toBeNull();
    }
  });

  it("keeps unavailable usage distinct from a zero balance or authentication failure", async () => {
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(validUsageAccount({
        state: "unavailable", reason: "billing_unavailable",
        included: { state: "unavailable", usedPercent: null, resetsAt: null },
        prepaid: { balanceUsd: null, fallbackEnabled: false },
      })),
    });
    const account = await client.getInferenceAccount();
    expect(account?.state).toBe("unavailable");
    expect(account?.included.usedPercent).toBeNull();
    expect(account?.prepaid.balanceUsd).toBeNull();
    for (const [status, error] of [[401, CloudUnauthorizedError], [403, CloudForbiddenError]] as const) {
      const denied = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => new Response(null, { status }) });
      await expect(denied.getInferenceAccount()).rejects.toBeInstanceOf(error);
    }
  });

  it("preserves exact money while excluding private accounting at every depth", async () => {
    const privateValue = "PRIVATE-SUPPLIER-ACCOUNTING";
    const payload = JSON.parse(JSON.stringify(validUsageAccount()), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, supplierInternal: privateValue } : value,
    );
    const client = new CloudClient({ host: HOST, token: SECRET, fetchImpl: async () => jsonResponse(payload) });
    const account = await client.getInferenceAccount();
    expect(account?.prepaid.balanceUsd).toBe("123456789.012345678");
    expect(JSON.stringify(account)).not.toContain(privateValue);
  });

  it("does not report a denied or malformed prepaid update as successful", async () => {
    const denied = new CloudClient({
      host: HOST, token: SECRET, fetchImpl: async () => new Response(null, { status: 403 }),
    });
    await expect(denied.patchInferenceAccountPrepaid(true)).rejects.toBeInstanceOf(CloudForbiddenError);
    const malformed = new CloudClient({
      host: HOST, token: SECRET, fetchImpl: async () => jsonResponse({ enabled: "false" }),
    });
    await expect(malformed.patchInferenceAccountPrepaid(false)).rejects.toBeInstanceOf(CloudError);
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

  it("leaves code undefined when the body has none", async () => {
    const client = new CloudClient({ host: HOST2, token: SECRET2,
      fetchImpl: (async () => new Response("oops", { status: 500 })) as typeof fetch });
    await expect(client.getInferenceModels()).rejects.toMatchObject({ name: "CloudError", status: 500 });
  });
});