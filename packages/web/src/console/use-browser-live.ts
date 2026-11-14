import { useEffect, useState } from "react";
import { useBackendApi } from "@/api";

export const MAX_BROWSER_STREAM_BUFFER = 4 * 1024 * 1024;
export type BrowserLiveStatus = "connecting" | "live" | "closed" | "unavailable" | "expired" | "paused";
export interface BrowserLiveView { id: string; pageId: string; sessionId: string; producerId: string; tab: string; url: string; title?: string; liveAvailable: boolean }
export interface BrowserLiveFrame { src: string; capturedAt: string; width?: number; height?: number }
export type BrowserStreamMessage = { type: "frame"; frame: BrowserLiveFrame } | { type: "state"; status: Exclude<BrowserLiveStatus, "paused"> };

/** Incremental SSE decoding handles CRLF and arbitrary network chunk boundaries. */
export function browserStreamParser(onMessage: (message: BrowserStreamMessage) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      if (match.index > MAX_BROWSER_STREAM_BUFFER) throw new Error("Browser frame exceeds size limit");
      const event = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      let type = "message";
      const data: string[] = [];
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      let value: Record<string, unknown>;
      try { value = JSON.parse(data.join("\n")); } catch { continue; }
      if (!value || typeof value !== "object") continue;
      if (type === "frame" && value.mimeType === "image/jpeg" && typeof value.data === "string" && value.data.length > 0 && value.data.length <= MAX_BROWSER_STREAM_BUFFER - 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data) && typeof value.capturedAt === "string" && Number.isFinite(Date.parse(value.capturedAt))) {
        onMessage({ type: "frame", frame: { src: `data:image/jpeg;base64,${value.data}`, capturedAt: value.capturedAt, ...(typeof value.width === "number" && value.width > 0 ? { width: value.width } : {}), ...(typeof value.height === "number" && value.height > 0 ? { height: value.height } : {}) } });
      } else if (type === "state" && ["connecting", "live", "closed", "unavailable", "expired"].includes(String(value.status))) onMessage({ type: "state", status: value.status as Exclude<BrowserLiveStatus, "paused"> });
    }
    if (buffer.length > MAX_BROWSER_STREAM_BUFFER) throw new Error("Browser stream exceeds size limit");
  };
}

export function browserViews(value: unknown, _consoleSessionId?: string): BrowserLiveView[] {
  const views = value && typeof value === "object" && "views" in value ? (value as { views: unknown }).views : null;
  if (!Array.isArray(views)) return [];
  return views.filter((view): view is BrowserLiveView => view && typeof view === "object" && typeof view.id === "string" && typeof view.pageId === "string" && view.pageId.length > 0 && view.pageId.length <= 256 && typeof view.sessionId === "string" && typeof view.producerId === "string" && typeof view.tab === "string" && typeof view.url === "string" && typeof view.liveAvailable === "boolean").slice(0, 12);
}

export function useBrowserLive(view: BrowserLiveView, enabled: boolean, consoleSessionId: string) {
  const { client } = useBackendApi();
  const [retry, setRetry] = useState(0);
  const [frame, setFrame] = useState<BrowserLiveFrame | null>(null);
  const [status, setStatus] = useState<BrowserLiveStatus>("connecting");
  useEffect(() => {
    setFrame(null);
  }, [client.backendId, consoleSessionId, view.pageId]);
  useEffect(() => {
    if (!enabled || !view.liveAvailable) { setStatus(view.liveAvailable ? "paused" : "unavailable"); return; }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, client.signal]);
    let terminal = false;
    async function connect() {
      while (!signal.aborted && !terminal) {
        setStatus("connecting");
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await client.request(`/api/console/sessions/${encodeURIComponent(consoleSessionId)}/browser/views/${encodeURIComponent(view.pageId)}/stream`, { signal, headers: { Accept: "text/event-stream" } });
          if ([403, 404, 409, 410].includes(response.status)) { setStatus(response.status === 410 ? "expired" : "unavailable"); return; }
          if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Browser stream unavailable");
          reader = response.body.getReader();
          let receivedFrame = false;
          const parse = browserStreamParser(message => {
            if (signal.aborted || terminal) return;
            if (message.type === "frame") { receivedFrame = true; setFrame(message.frame); setStatus("live"); }
            else if (["closed", "unavailable", "expired"].includes(message.status)) { terminal = true; setStatus(message.status); }
            else setStatus(message.status === "live" && receivedFrame ? "live" : "connecting");
          });
          const decoder = new TextDecoder();
          while (!signal.aborted && !terminal) {
            const { value, done } = await reader.read();
            if (done) break;
            parse(decoder.decode(value, { stream: true }));
          }
        } catch { if (signal.aborted) return; }
        finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
        if (signal.aborted || terminal) return;
        setStatus("connecting");
        await new Promise<void>(resolve => {
          const cancel = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 1500);
          signal.addEventListener("abort", cancel, { once: true });
        });
      }
    }
    void connect();
    return () => controller.abort();
  }, [client, consoleSessionId, view.pageId, view.liveAvailable, enabled, retry]);
  return { frame, status, reconnect: () => setRetry(value => value + 1) };
}
