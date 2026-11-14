import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebConsoleApiRequest } from "./dashboard-api.js";
import type { ConsoleGateway } from "./console-gateway.js";

let server: Server | undefined;
afterEach(async () => { await new Promise<void>(resolve => { server?.closeAllConnections(); server ? server.close(() => resolve()) : resolve(); }); server = undefined; });

async function serve(gateway: Partial<Record<keyof ConsoleGateway, unknown>>) {
  const none = { handle: async () => null };
  server = createServer((req, res) => {
    void handleWebConsoleApiRequest(req, res, new URL(req.url ?? "/", "http://localhost"), gateway as unknown as ConsoleGateway, none as never, none as never, none as never, {} as never, none as never)
      .then(handled => { if (!handled) { res.statusCode = 404; res.end(); } })
      .catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject).end();
  });
}

describe("console snapshot window routes", () => {
  it("serves the legacy snapshot by default and the windowed one only on request", async () => {
    const get = vi.fn(() => ({ legacy: true })); const getWindowed = vi.fn(() => ({ windowed: true }));
    const call = await serve({ get, getWindowed });
    expect(JSON.parse((await call("/api/console/sessions/s1")).body)).toEqual({ snapshot: { legacy: true } });
    expect(JSON.parse((await call("/api/console/sessions/s1?window=50&workers=summary")).body)).toEqual({ snapshot: { windowed: true } });
    expect(getWindowed).toHaveBeenLastCalledWith("s1", { window: 50, workers: "summary" });
    expect(getWindowed.mock.calls).toHaveLength(1);
    expect((await call("/api/console/sessions/s1?window=0")).status).toBe(400);
    expect((await call("/api/console/sessions/s1?window=5000")).status).toBe(400);
    expect((await call("/api/console/sessions/s1?workers=bogus")).status).toBe(400);
  });

  it("serves tools with an ETag and 304, a single worker, and message pages", async () => {
    const tools = [{ name: "t", description: "d", inputSchema: {} }];
    const worker = vi.fn(() => ({ id: "w1", transcript: [1, 2, 3] }));
    const messagesPage = vi.fn(() => ({ messages: [], total: 0, firstIndex: 0, hasMore: false }));
    const call = await serve({ tools: () => tools, worker, messagesPage });
    const first = await call("/api/console/sessions/s1/tools");
    expect(JSON.parse(first.body)).toEqual({ tools });
    const etag = first.headers["etag"] as string;
    expect(etag).toBeTruthy();
    expect((await call("/api/console/sessions/s1/tools", { "if-none-match": etag })).status).toBe(304);
    expect(JSON.parse((await call("/api/console/sessions/s1/workers/w1")).body)).toEqual({ worker: { id: "w1", transcript: [1, 2, 3] } });
    expect(worker).toHaveBeenCalledWith("s1", "w1");
    await call("/api/console/sessions/s1/messages?before=7&limit=20");
    expect(messagesPage).toHaveBeenCalledWith("s1", { before: 7, limit: 20 });
    expect((await call("/api/console/sessions/s1/messages?limit=0")).status).toBe(400);
  });

  it("long-polls events: waits before answering, honours resync, and validates wait", async () => {
    let release: () => void = () => undefined;
    const waitForEvents = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const eventsAfter = vi.fn(() => ({ events: [], cursor: 4, gap: false }));
    const call = await serve({ waitForEvents, eventsAfter });
    let answered = false;
    const pending = call("/api/console/sessions/s1/events?after=4&wait=20&window=1").then(result => { answered = true; return result; });
    await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalled());
    expect((waitForEvents.mock.calls[0] as unknown[]).slice(0, 3)).toEqual(["s1", 4, 20_000]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(answered).toBe(false);
    release();
    expect((await pending).status).toBe(200);
    expect(eventsAfter).toHaveBeenCalledWith("s1", 4, { resync: true });
    // Without wait: no holding, default (non-resync) behaviour.
    await call("/api/console/sessions/s1/events?after=4");
    expect(waitForEvents).toHaveBeenCalledTimes(1);
    expect(eventsAfter).toHaveBeenLastCalledWith("s1", 4, { resync: false });
    expect((await call("/api/console/sessions/s1/events?after=4&wait=26")).status).toBe(400);
  });

  it("serves a read-only saved transcript with window and paging parameters", async () => {
    const savedTranscript = vi.fn(() => ({ meta: {}, messages: [], total: 0, firstIndex: 0, hasMore: false }));
    const call = await serve({ savedTranscript });
    await call("/api/console/saved/abc/transcript?window=30");
    expect(savedTranscript).toHaveBeenLastCalledWith("abc", { window: 30 });
    await call("/api/console/saved/abc/transcript?before=10&limit=5");
    expect(savedTranscript).toHaveBeenLastCalledWith("abc", { before: 10, limit: 5 });
    expect((await call("/api/console/saved/abc/transcript?window=0")).status).toBe(400);
  });
});
