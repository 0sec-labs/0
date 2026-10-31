import type { IncomingMessage, ServerResponse } from "node:http";
import { listBrowserViews, subscribeBrowserView } from "@0/core";

interface BrowserView {
  pageId: string;
  liveAvailable: boolean;
}
interface BrowserFrame {
  data: string;
  mimeType: "image/jpeg";
  capturedAt: string;
  width?: number;
  height?: number;
}
interface BrowserViewRegistry {
  list(ownerId: string): BrowserView[];
  subscribe(ownerId: string, pageId: string, onFrame: (frame: BrowserFrame) => void): Promise<() => void>;
}
const registry: BrowserViewRegistry = { list: listBrowserViews, subscribe: subscribeBrowserView };
const HEARTBEAT_MS = 15_000;
const STREAM_LIFETIME_MS = 5 * 60_000;

/** Call only after control-token, team identity and conversation access checks. */
export async function handleBrowserLiveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ownerId: string,
  pageId?: string,
  source: BrowserViewRegistry = registry,
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  // Fetch supplies header authentication. Never put credentials in stream URLs.
  if (url.search) { reply(400, { error: "Browser view endpoints do not accept query parameters." }); return; }
  if (req.method !== "GET") { reply(405, { error: "Use GET for browser views." }); return; }
  const views = source.list(ownerId);
  if (!pageId) { reply(200, { views }); return; }
  const view = views.find(item => item.pageId === pageId);
  if (!view) { reply(404, { error: "Browser view was closed or does not belong to this conversation." }); return; }
  if (!view.liveAvailable) { reply(409, { error: "Live browser view is unavailable for this execution backend." }); return; }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  let closed = false;
  let blocked = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    unsubscribe?.();
    unsubscribe = undefined;
    res.off("drain", drain);
    res.off("close", cleanup);
    res.off("error", cleanup);
    req.off("aborted", cleanup);
  };
  const drain = () => { blocked = false; };
  const write = (event: string, data: unknown) => {
    if (closed || blocked || res.destroyed || res.writableEnded) return;
    // At most the one accepted write is buffered by Node; subsequent frames drop.
    blocked = !res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = (status: string) => {
    write("state", { status });
    cleanup();
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  res.on("drain", drain);
  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("aborted", cleanup);
  write("state", { status: "connecting" });
  heartbeat = setInterval(() => {
    try {
      if (!source.list(ownerId).some(item => item.pageId === pageId)) { finish("closed"); return; }
      if (!closed && !blocked) blocked = !res.write(": heartbeat\n\n");
    } catch { finish("unavailable"); }
  }, HEARTBEAT_MS);
  lifetime = setTimeout(() => finish("expired"), STREAM_LIFETIME_MS);
  heartbeat.unref?.();
  lifetime.unref?.();
  try {
    const stop = await source.subscribe(ownerId, pageId, frame => {
      if (closed || blocked || frame.mimeType !== "image/jpeg" || frame.data.length > 4 * 1024 * 1024) return;
      write("frame", frame);
    });
    if (closed) stop();
    else { unsubscribe = stop; write("state", { status: "live" }); }
  } catch { finish("unavailable"); }
}
