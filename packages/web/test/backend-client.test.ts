import { it as test } from "vitest";
import assert from "node:assert/strict";
import { QueryClient } from "../node_modules/@tanstack/react-query/build/modern/index.js";
import { BackendClient, backendRoute, backendStorageKey } from "../src/lib/backend-client";
import { createBackendApi } from "../src/api";

const descriptor = (id: string, capabilities = ["sessions", "approvals", "workflows"]) => ({ id, name: id, transport: "http" as const, status: "connected" as const, protocolVersion: 1, capabilities });

test("equal resource IDs retain distinct request, approval, query, draft, and navigation owners", async () => {
  const paths: string[] = [];
  const transport = async (path: string) => { paths.push(path); return Response.json({ ok: true }); };
  const a = new BackendClient("lab.a", transport, descriptor("lab.a"));
  const b = new BackendClient("lab.b", transport, descriptor("lab.b"));
  await a.request("/api/console/sessions/shared/decisions/shared", { method: "POST" });
  await b.request("/api/console/sessions/shared/decisions/shared", { method: "POST" });
  assert.deepEqual(paths, ["/api/backends/lab.a/proxy/api/console/sessions/shared/decisions/shared", "/api/backends/lab.b/proxy/api/console/sessions/shared/decisions/shared"]);
  const cacheA = new QueryClient(), cacheB = new QueryClient();
  cacheA.setQueryData(["session", "shared"], "engine A"); cacheB.setQueryData(["session", "shared"], "engine B");
  assert.equal(cacheA.getQueryData(["session", "shared"]), "engine A"); assert.equal(cacheB.getQueryData(["session", "shared"]), "engine B");
  assert.notEqual(backendStorageKey("lab.a", "draft:shared"), backendStorageKey("lab.b", "draft:shared"));
  assert.deepEqual(backendRoute("/b/lab.a/console/shared"), { backendId: "lab.a", basename: "/b/lab.a" });
  assert.deepEqual(backendRoute("/chats/shared"), { backendId: "local", basename: "" });
});

test("a retired view aborts pending requests and never dispatches late follow-up mutations", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const client = new BackendClient("lab", async (_path, init) => { calls++; signal = init?.signal; return new Promise(resolve => { release = resolve; }); });
  const pending = client.request("/api/console/sessions/shared");
  client.dispose();
  assert.equal(signal?.aborted, true);
  release(Response.json({ id: "shared" }));
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(client.request("/api/console/sessions/shared/messages", { method: "POST" }), /disconnected/);
  assert.equal(calls, 1);
});

test("credentials cannot route to supplied origins, registry paths, or escaped API paths", async () => {
  const client = new BackendClient("local", async () => { throw new Error("Must not dispatch"); });
  for (const path of ["https://elsewhere.example/api/x", "//elsewhere.example/api/x", "/api/../../elsewhere", "/api/\\elsewhere", "/api/backends/lab/handshake"]) assert.throws(() => client.route(path), /API path/);
  for (const id of ["constructor", "__proto__", "_leading", "../other"]) assert.throws(() => new BackendClient(id, async () => Response.json({})));
});

test("unsupported operation capabilities reject before transport dispatch", async () => {
  let calls = 0;
  assert.throws(() => new BackendClient("A", async () => Response.json({}), descriptor("B")), /another computer/);
  const client = new BackendClient("sessions-only", async () => { calls++; return Response.json({}); }, descriptor("sessions-only", ["sessions"]));
  await assert.rejects(client.request("/api/console/workflow-definitions/w/run", { method: "POST" }), /does not support workflows/);
  await assert.rejects(client.request("/api/console/sessions/s/decisions/d", { method: "POST" }), /does not support approvals/);
  await client.request("/api/console/sessions/s");
  assert.equal(calls, 1);
});

test("a backend switch during JSON decoding cannot complete a stale mutation", async () => {
  let release!: (body: unknown) => void;
  const oldFetch = globalThis.fetch;
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" } }, document: { querySelector: () => null } });
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: () => new Promise(resolve => { release = resolve; }) }) as unknown as Response;
  try {
    const api = createBackendApi("lab");
    const pending = api.webFetchJson("/api/console/sessions/shared/messages", { method: "POST" });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    api.client.dispose(); release({ session: { id: "shared" } });
    await assert.rejects(pending, /disconnected/);
  } finally { Object.assign(globalThis, { fetch: oldFetch, window: oldWindow, document: oldDocument }); }
});
