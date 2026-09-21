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

/**
 * A valid CreditAccount fixture with representative values across all
 * sections. Every credit-nano field is a decimal integer string; null
 * subsections are left null.
 */
function validCreditAccount(overrides?: Partial<CreditAccount>): CreditAccount {
  return {
    schemaVersion: "credits-v1",
    snapshotAt: "2026-09-18T12:00:00Z",
    policyVersion: "v1",
    scope: { orgId: "org_test123" },
    state: "ready",
    reason: null,
    free: {
      state: "active",
      claimableCreditNanos: "500000000000000000000000000000",
      spendableCreditNanos: "100000000000000000000000000000",
      heldCreditNanos: null,
      resetAt: "2026-10-18T00:00:00Z",
    },
    subscription: {
      state: "active",
      priceCents: 1500,
      periodStart: "2026-09-01T00:00:00Z",
      periodEnd: "2026-09-30T23:59:59Z",
      windows: [
        {
          kind: "monthly",
          limitCreditNanos: "50000000000000000000000",
          settledCreditNanos: "25000000000000000000000",
          heldCreditNanos: null,
          availableCreditNanos: "25000000000000000000000",
          resetsAt: "2026-10-01T00:00:00Z",
        },
      ],
    },
    prepaid: {
      spendableCreditNanos: "100000000000000000000000000000",
      heldCreditNanos: null,
      settledDeficitCreditNanos: null,
      holdShortfallCreditNanos: null,
      consentEnabled: false,
    },
    purchase: {
      enabled: true,
      presets: [
        { principalCents: 1000, creditNanos: "1000000000000" },
      ],
      customMinCents: 1000,
      customMaxCents: 100000,
      stepCents: 100,
      currency: "usd",
    },
    admission: {
      eligible: true,
      reason: null,
    },
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

describe("CloudClient.getInferenceAccount — CreditAccount v1 DTO", () => {
  it("preserves exact credit nano strings (large decimal integers)", async () => {
    const fixture = validCreditAccount({
      free: {
        state: "active",
        claimableCreditNanos: "500000000000000000000000000000",
        spendableCreditNanos: "999999999999999999999999999999",
        heldCreditNanos: "1",
        resetAt: null,
      },
    });
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(fixture),
    });
    const result = await client.getInferenceAccount();
    expect(result?.free.claimableCreditNanos).toBe("500000000000000000000000000000");
    expect(result?.free.spendableCreditNanos).toBe("999999999999999999999999999999");
    expect(result?.free.heldCreditNanos).toBe("1");
  });

  it("returns null for malformed/legacy/null HTTP 200 data", async () => {
    // Legacy response (old InferenceAccountResponse shape)
    const client1 = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse({ remainingUsd: 50, currency: "USD" }),
    });
    expect(await client1.getInferenceAccount()).toBeNull();

    // Completely empty object
    const client2 = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse({}),
    });
    expect(await client2.getInferenceAccount()).toBeNull();

    // null body
    const client3 = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(null),
    });
    expect(await client3.getInferenceAccount()).toBeNull();
  });

  it("returns null for wrong schemaVersion", async () => {
    const fixture = validCreditAccount({ schemaVersion: "credits-v0" as "credits-v1" });
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(fixture),
    });
    expect(await client.getInferenceAccount()).toBeNull();
  });

  it("returns null for structurally invalid payload", async () => {
    const bad: Record<string, unknown> = { ...validCreditAccount(), free: "not_an_object" };
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(bad),
    });
    expect(await client.getInferenceAccount()).toBeNull();
  });

  it("preserves disabled/restricted state from HTTP 200 (not auth failure)", async () => {
    const disabled = validCreditAccount({ state: "disabled", reason: "billing_hold" });
    const client1 = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(disabled),
    });
    const d = await client1.getInferenceAccount();
    expect(d).not.toBeNull();
    expect(d!.state).toBe("disabled");
    expect(d!.reason).toBe("billing_hold");

    const restricted = validCreditAccount({ state: "restricted", reason: "trial_expired" });
    const client2 = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(restricted),
    });
    const r = await client2.getInferenceAccount();
    expect(r).not.toBeNull();
    expect(r!.state).toBe("restricted");
    expect(r!.reason).toBe("trial_expired");
  });

  it("still throws 401/403 (auth distinct from unavailable credit)", async () => {
    const client401 = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });
    await expect(client401.getInferenceAccount()).rejects.toBeInstanceOf(CloudUnauthorizedError);

    const client403 = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => new Response("nope", { status: 403 }),
    });
    await expect(client403.getInferenceAccount()).rejects.toBeInstanceOf(CloudForbiddenError);
  });

  it("preserves distinct subscription windows without combining", async () => {
    const fixture = validCreditAccount({
      subscription: {
        state: "active",
        priceCents: 1500,
        periodStart: "2026-09-01T00:00:00Z",
        periodEnd: "2026-09-30T23:59:59Z",
        windows: [
          {
            kind: "monthly",
            limitCreditNanos: "50000000000000000000000",
            settledCreditNanos: "25000000000000000000000",
            heldCreditNanos: "5000000000000000000000",
            availableCreditNanos: "20000000000000000000000",
            resetsAt: "2026-10-01T00:00:00Z",
          },
          {
            kind: "weekly",
            limitCreditNanos: "10000000000000000000000",
            settledCreditNanos: "3000000000000000000000",
            heldCreditNanos: null,
            availableCreditNanos: "7000000000000000000000",
            resetsAt: "2026-09-25T00:00:00Z",
          },
        ],
      },
    });
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(fixture),
    });
    const result = await client.getInferenceAccount();
    expect(result?.subscription.windows.map((window) => [window.kind, window.availableCreditNanos]))
      .toEqual([
        ["monthly", "20000000000000000000000"],
        ["weekly", "7000000000000000000000"],
      ]);
  });

  it("preserves nullable nanos in free and prepaid sections", async () => {
    const fixture = validCreditAccount({
      free: {
        state: "ineligible",
        claimableCreditNanos: null,
        spendableCreditNanos: null,
        heldCreditNanos: null,
        resetAt: null,
      },
      prepaid: {
        spendableCreditNanos: null,
        heldCreditNanos: null,
        settledDeficitCreditNanos: null,
        holdShortfallCreditNanos: null,
        consentEnabled: false,
      },
    });
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(fixture),
    });
    const result = await client.getInferenceAccount();
    expect(result?.free.claimableCreditNanos).toBeNull();
    expect(result?.free.spendableCreditNanos).toBeNull();
    expect(result?.prepaid.spendableCreditNanos).toBeNull();
    expect(result?.prepaid.heldCreditNanos).toBeNull();
  });

  it("returns null when credit nano is a JSON number instead of a string", async () => {
    const jsonNumberPayload = { ...validCreditAccount() };
    (jsonNumberPayload as Record<string, unknown>).free = {
      state: "active",
      claimableCreditNanos: 50000,
      spendableCreditNanos: "10000",
      heldCreditNanos: null,
      resetAt: null,
    };
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(jsonNumberPayload),
    });
    expect(await client.getInferenceAccount()).toBeNull();
  });

  it("rejects out-of-contract money and reset values without an auth error", async () => {
    const account = validCreditAccount();
    const malformed = [
      { ...account, free: { ...account.free, spendableCreditNanos: "1".repeat(31) } },
      { ...account, purchase: { ...account.purchase, presets: [{ principalCents: 1000, creditNanos: "1e9" }] } },
      { ...account, purchase: { ...account.purchase, presets: [{ principalCents: Number.MAX_SAFE_INTEGER + 1, creditNanos: "1" }] } },
      { ...account, subscription: { ...account.subscription, priceCents: 1501 } },
      { ...account, purchase: { ...account.purchase, currency: "eur" } },
      { ...account, purchase: { ...account.purchase, stepCents: 50 } },
      { ...account, free: { ...account.free, resetAt: "not-a-date" } },
    ];
    for (const payload of malformed) {
      const client = new CloudClient({
        host: HOST, token: SECRET,
        fetchImpl: async () => jsonResponse(payload),
      });
      expect(await client.getInferenceAccount()).toBeNull();
    }
  });

  it("keeps private accounting extensions out of the customer DTO at every depth", async () => {
    const privateValue = "PRIVATE-SUPPLIER-ACCOUNTING";
    const payload = JSON.parse(JSON.stringify(validCreditAccount()), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, supplierInternal: privateValue }
        : value,
    );
    const client = new CloudClient({
      host: HOST, token: SECRET,
      fetchImpl: async () => jsonResponse(payload),
    });
    const account = await client.getInferenceAccount();
    expect(account?.schemaVersion).toBe("credits-v1");
    expect(JSON.stringify(account)).not.toContain(privateValue);
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