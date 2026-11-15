import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebOperatorServices } from "./operator-services.js";
import { listPendingReports } from "../state/pending-diagnostics.js";

const policy = vi.hoisted(() => ({ value: "ask" as "off" | "ask" | "automatic" }));
vi.mock("../state/settings-store.js", async (original) => ({
  ...await original<typeof import("../state/settings-store.js")>(),
  getSettings: () => ({ diagnosticReporting: policy.value, modelPreference: undefined }),
}));

const DSN = "https://abc123@o0.ingest.de.sentry.io/1";
let home: string;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  policy.value = "ask";
  home = realpathSync(mkdtempSync(join(tmpdir(), "zero-operator-diag-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZERO_SENTRY_DSN", DSN);
  for (const name of ["ZERO_OFFLINE", "ZERO_NO_TELEMETRY", "DO_NOT_TRACK"]) vi.stubEnv(name, undefined);
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

const call = (service: WebOperatorServices, method: string, path: string, body?: unknown) =>
  service.handle(`/api/console/${path}`, method, body, new URLSearchParams());
const report = (extra: Record<string, unknown> = {}) => ({ name: "TypeError", frames: ["assets/index-abc123.js:10:20"], surface: "web", ...extra });

describe("browser error reports", () => {
  it("stores a finite pending report in ask mode and sends nothing", async () => {
    const service = new WebOperatorServices();
    expect(await call(service, "POST", "diagnostics/report", report())).toMatchObject({ status: 202, data: { accepted: true } });
    expect(fetchMock).not.toHaveBeenCalled();
    const list = (await call(service, "GET", "diagnostics/pending"))!.data as { reports: Array<Record<string, unknown>> };
    expect(list.reports).toHaveLength(1);
    expect(Object.keys(list.reports[0]!).sort()).toEqual(["category", "createdAt", "id", "surface"]);
    expect(list.reports[0]).toMatchObject({ category: "TypeError", surface: "web" });
  });

  it("de-duplicates the same category and top frame", async () => {
    const service = new WebOperatorServices();
    for (let n = 0; n < 3; n++) await call(service, "POST", "diagnostics/report", report());
    await call(service, "POST", "diagnostics/report", report({ name: "RangeError" }));
    expect(listPendingReports(home)).toHaveLength(2);
  });

  it("drops reports when reporting is off or opted out", async () => {
    policy.value = "off";
    await call(new WebOperatorServices(), "POST", "diagnostics/report", report());
    policy.value = "ask"; vi.stubEnv("DO_NOT_TRACK", "1");
    await call(new WebOperatorServices(), "POST", "diagnostics/report", report({ name: "RangeError" }));
    expect(listPendingReports(home)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits once in automatic mode", async () => {
    policy.value = "automatic";
    await call(new WebOperatorServices(), "POST", "diagnostics/report", report());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as { body: string };
    expect(init.body).toContain('"surface":"web"');
    expect(init.body).not.toMatch(/Cannot|http|\/Users/);
  });

  it.each([
    ["null", null], ["array", []], ["string", "x"], ["empty", {}],
    ["free-text name", report({ name: "Error: secret host.example" })],
    ["extra field", report({ message: "Cannot read secret" })],
    ["cli surface", report({ surface: "cli" })],
    ["absolute path frame", report({ frames: ["/Users/alice/app.js:1:1"] })],
    ["origin frame", report({ frames: ["https://evil.example/assets/x.js:1:1"] })],
    ["query frame", report({ frames: ["assets/x.js?token=abc:1:1"] })],
    ["too many frames", report({ frames: Array(17).fill("assets/x.js:1:1") })],
    ["non-array frames", report({ frames: "assets/x.js:1:1" })],
  ])("rejects malformed report bodies with 400: %s", async (_label, body) => {
    const result = await call(new WebOperatorServices(), "POST", "diagnostics/report", body);
    expect(result!.status).toBe(400);
    expect(listPendingReports(home)).toEqual([]);
  });

  it("is POST only", async () => {
    expect((await call(new WebOperatorServices(), "GET", "diagnostics/report"))!.status).toBe(405);
  });
});

describe("pending report review", () => {
  const stored = async (service: WebOperatorServices) => {
    await call(service, "POST", "diagnostics/report", report());
    return listPendingReports(home)[0]!.id;
  };

  it("requires a preview and confirmation before anything is sent", async () => {
    const service = new WebOperatorServices();
    const id = await stored(service);
    expect((await call(service, "POST", `diagnostics/pending/${id}`, { action: "send" }))!.status).toBe(409);
    expect((await call(service, "POST", `diagnostics/pending/${id}`, { action: "send", previewId: "guess" }))!.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();

    const preview = (await call(service, "POST", `diagnostics/pending/${id}`, { action: "preview" }))!.data as { previewId: string; preview: { body: string; headers: Record<string, string>; url: string } };
    expect(preview.preview.body).toContain("WebError");
    expect(JSON.stringify(preview)).not.toContain("abc123@");
    expect(preview.preview.headers["x-sentry-auth"]).toContain("<redacted>");
    expect(fetchMock).not.toHaveBeenCalled();

    expect((await call(service, "POST", `diagnostics/pending/${id}`, { action: "send", previewId: "wrong" }))!.status).toBe(409);
    const sent = await call(service, "POST", `diagnostics/pending/${id}`, { action: "send", previewId: preview.previewId });
    expect(sent).toMatchObject({ status: 200, data: { submitted: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as { body: string }).body).toBe(preview.preview.body);
    expect(listPendingReports(home)).toEqual([]);
    // A used preview cannot be replayed.
    expect((await call(service, "POST", `diagnostics/pending/${id}`, { action: "send", previewId: preview.previewId }))!.status).toBe(404);
  });

  it("a preview for one report cannot send another", async () => {
    const service = new WebOperatorServices();
    const a = await stored(service);
    await call(service, "POST", "diagnostics/report", report({ name: "RangeError" }));
    const b = listPendingReports(home).find((entry) => entry.id !== a)!.id;
    const preview = (await call(service, "POST", `diagnostics/pending/${a}`, { action: "preview" }))!.data as { previewId: string };
    expect((await call(service, "POST", `diagnostics/pending/${b}`, { action: "send", previewId: preview.previewId }))!.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the report when the transport fails, and discard removes it", async () => {
    const service = new WebOperatorServices();
    const id = await stored(service);
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 500 }));
    const preview = (await call(service, "POST", `diagnostics/pending/${id}`, { action: "preview" }))!.data as { previewId: string };
    expect((await call(service, "POST", `diagnostics/pending/${id}`, { action: "send", previewId: preview.previewId }))!.status).toBe(409);
    expect(listPendingReports(home)).toHaveLength(1);
    expect((await call(service, "POST", `diagnostics/pending/${id}`, { action: "discard" }))!.data).toMatchObject({ discarded: true });
    expect(listPendingReports(home)).toEqual([]);
  });

  it("refuses to preview when reporting is opted out", async () => {
    const service = new WebOperatorServices();
    const id = await stored(service);
    vi.stubEnv("ZERO_OFFLINE", "1");
    expect((await call(service, "POST", `diagnostics/pending/${id}`, { action: "preview" }))!.status).toBe(409);
  });

  it.each(["..%2f..%2fetc%2fpasswd", "%zz", "../x", "..", "ABCDEF", "a".repeat(31), "a".repeat(33), "a".repeat(32), "%00", "x%2Fy"])("malformed or unknown id %s is a 4xx, never a 500", async (id) => {
    const service = new WebOperatorServices();
    for (const body of [{ action: "preview" }, { action: "send", previewId: "x" }, { action: "discard" }, null, [], "x", { action: ["send"] }]) {
      const result = await call(service, "POST", `diagnostics/pending/${id}`, body);
      if (result) expect(result.status).toBeGreaterThanOrEqual(400), expect(result.status).toBeLessThan(500);
    }
  });

  it("rejects bad bodies and methods for a real report", async () => {
    const service = new WebOperatorServices();
    const id = await stored(service);
    for (const body of [null, [], "x", {}, { action: "delete" }, { action: ["preview"] }]) {
      expect((await call(service, "POST", `diagnostics/pending/${id}`, body))!.status).toBe(400);
    }
    expect((await call(service, "GET", `diagnostics/pending/${id}`))!.status).toBe(405);
    expect((await call(service, "PUT", "diagnostics/pending"))!.status).toBe(405);
    expect(listPendingReports(home)).toHaveLength(1);
  });
});
