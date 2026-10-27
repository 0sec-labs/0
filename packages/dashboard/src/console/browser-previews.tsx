import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { browserViews, useBrowserLive, type BrowserLiveView } from "./use-browser-live";
import { Globe, Maximize2, X } from "lucide-react";
import type { ConsoleSessionSnapshot, DesktopConsoleToolCall } from "@0/shared";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { imageSource, toolImages } from "./inline-image";

export interface BrowserPreview {
  id: string;
  viewId: string;
  src: string;
  title: string;
  url?: string;
  owner: string;
  capturedAt: number;
  pageId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Latest actual browser captures per tab and owner, never a simulated live view. */
export function browserPreviews(snapshot: ConsoleSessionSnapshot): BrowserPreview[] {
  const captures: BrowserPreview[] = [];
  function collect(call: DesktopConsoleToolCall, result: unknown, ownerId: string, owner: string, id: string, capturedAt: number) {
    // Image generation and unrelated tool images belong in the transcript only.
    if (!/browser|playwright|puppeteer|computer|cua|screenshot/i.test(call.name)) return;
    let decoded = result;
    if (typeof result === "string") {
      try { decoded = JSON.parse(result); } catch { return; }
    }
    const receipt = record(decoded);
    const output = record(receipt.output);
    const args = record(call.arguments);
    const browser = record(record(receipt.meta).browser);
    const url = text(browser.url) || text(output.url) || text(args.url);
    const tab = text(browser.tab) || text(output.tab) || text(output.tabId) || text(args.tab) || text(args.tabId);
    let hostname: string | undefined;
    try { hostname = url ? new URL(url).hostname : undefined; } catch { /* A capture can lack URL metadata. */ }
    const title = text(browser.title) || text(output.title) || text(output.screenshot_caption) || hostname || "Browser capture";
    toolImages(decoded).forEach((image, index) => {
      const safe = imageSource(image.src);
      if (!safe || !safe.startsWith("data:image/")) return;
      captures.push({
      id: `${ownerId}:${id}:${index}`,
      viewId: `${ownerId}:${tab || url || "browser"}:${index}`,
      src: safe,
      title,
      url,
      owner,
      capturedAt,
      pageId: text(browser.pageId) || text(record(receipt.meta).browserPageId) || text(output.browserPageId) || text(output.pageId),
      });
    });
  }
  for (const event of snapshot.events) {
    if (event.type === "tool-result") collect(event.call, event.result, "main", "Main conversation", String(event.sequence), Date.parse(event.occurredAt) || 0);
  }
  for (const worker of snapshot.workers) {
    for (const turn of worker.transcript) {
      for (const tool of turn.tools || []) {
        collect(tool.call, tool.result, worker.id, worker.name, `${turn.turn}:${tool.callIndex}:${tool.call.id || ""}`, turn.ts);
      }
    }
  }
  const latest = new Map<string, BrowserPreview>();
  for (const capture of captures.sort((a, b) => a.capturedAt - b.capturedAt)) latest.set(capture.viewId, capture);
  return [...latest.values()].sort((a, b) => b.capturedAt - a.capturedAt).slice(0, 6);
}

function CaptureCard({ preview, onDismiss }: { preview: BrowserPreview; onDismiss: () => void }) {
  const [failed, setFailed] = useState(false);
  return <article className="overflow-hidden rounded-[var(--radius-panel)] border border-border/60 bg-muted/30 shadow-sm">
    <div className="flex items-center gap-2 bg-muted/60 py-2 pl-3 pr-1.5">
      <Globe aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={preview.url || preview.title}>{preview.title}</span>
      <button type="button" aria-label={`Dismiss capture: ${preview.title}`} onClick={onDismiss} className="rounded-[var(--radius-control)] p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button>
    </div>
    {failed ? <p className="p-5 text-xs text-muted-foreground">Capture unavailable</p> : <Dialog>
      <DialogTrigger asChild><button type="button" aria-label={`Expand capture: ${preview.title}`} className="group relative block w-full bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <img src={preview.src} alt={preview.title} loading="lazy" onError={() => setFailed(true)} className="h-40 w-full object-contain" />
        <span className="absolute bottom-2 right-2 rounded-[var(--radius-control)] bg-black/60 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Maximize2 className="size-3.5" /></span>
      </button></DialogTrigger>
      <DialogContent className="w-fit max-w-[95vw] p-3 pt-12 sm:max-w-[95vw]"><DialogTitle className="sr-only">{preview.title} — captured screenshot</DialogTitle><img src={preview.src} alt={preview.title} className="max-h-[82dvh] max-w-full object-contain" /></DialogContent>
    </Dialog>}
    <p className="truncate px-3 py-2 text-[10px] text-muted-foreground" title={preview.owner}>Captured screenshot · {preview.owner}</p>
  </article>;
}

function LiveBrowserCard({ view, owner, fallback, onDismiss, sessionId }: { sessionId: string; view: BrowserLiveView; owner: string; fallback?: BrowserPreview; onDismiss: () => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const [intersecting, setIntersecting] = useState(false);
  const [visible, setVisible] = useState(() => typeof document !== "undefined" && !document.hidden);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    if (!ref.current || typeof IntersectionObserver === "undefined") setIntersecting(true);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => setIntersecting(Boolean(entry?.isIntersecting && entry.intersectionRatio >= .1)), { threshold: .1 });
    if (ref.current) observer?.observe(ref.current);
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  const { frame, status, reconnect } = useBrowserLive(view, visible && (intersecting || expanded), sessionId);
  const src = frame?.src || fallback?.src;
  const title = view.title || view.url || view.tab || "Browser view";
  let external: string | undefined;
  try { const url = new URL(view.url); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) external = url.href; } catch { /* Internal browser pages have no external link. */ }
  const label = status === "live" && frame ? "Live" : status === "connecting" ? "Connecting…" : status === "paused" ? "Paused" : status === "closed" ? "Closed" : status === "expired" ? "Expired" : "Captured screenshot";
  return <article ref={ref} className="overflow-hidden rounded-[var(--radius-panel)] border border-border/60 bg-muted/30 shadow-sm">
    <div className="flex items-center gap-2 bg-muted/60 py-2 pl-3 pr-1.5"><Globe aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-xs font-medium" title={view.url}>{title}</span><button type="button" aria-label={`Dismiss browser view: ${title}`} onClick={onDismiss} className="rounded-[var(--radius-control)] p-1 text-muted-foreground hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button></div>
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogTrigger asChild><button type="button" aria-label={`Expand browser view: ${title}`} className="group relative flex h-40 w-full items-center justify-center bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{src ? <img src={src} alt={title} className="h-40 w-full object-contain object-top" /> : <span className="px-4 text-xs text-muted-foreground">{view.liveAvailable ? "Waiting for browser frames…" : "Live view unavailable"}</span>}<span className="absolute bottom-2 right-2 rounded-[var(--radius-control)] bg-black/60 p-1.5 text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"><Maximize2 className="size-3.5" /></span></button></DialogTrigger>
      <DialogContent className="w-fit max-w-[95vw] p-3 pt-12 sm:max-w-[95vw]"><DialogTitle className="sr-only">{title} — browser view</DialogTitle>{src ? <img src={src} alt={title} className="max-h-[82dvh] max-w-full object-contain" /> : <p className="p-8 text-sm text-muted-foreground">Waiting for browser frames…</p>}<p className="text-xs text-muted-foreground">{label} · View only · {owner}</p>{external && <a href={external} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground underline underline-offset-4">Open page in a new tab</a>}</DialogContent>
    </Dialog>
    <p className="flex items-center gap-1.5 truncate px-3 py-2 text-[10px] text-muted-foreground" title={owner}>{status === "live" && frame && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}{label} · {owner}{view.liveAvailable && ["expired", "unavailable"].includes(status) && <button type="button" onClick={reconnect} className="ml-auto rounded-[var(--radius-control)] px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Reconnect</button>}</p>
  </article>;
}

export function BrowserPreviews({ snapshot, className = "", emptyState = false }: { snapshot: ConsoleSessionSnapshot; className?: string; emptyState?: boolean }) {
  const { client } = useBackendApi();
  const sessionId = snapshot.session.id;
  const registry = useQuery({ queryKey: ["browser-views", client.backendId, sessionId], queryFn: async ({ signal }) => {
    const response = await client.request(`/api/console/sessions/${encodeURIComponent(sessionId)}/browser/views`, { signal });
    if ([404, 501].includes(response.status)) return [];
    if (!response.ok) throw new Error("Browser views unavailable");
    return browserViews(await response.json(), sessionId);
  }, refetchInterval: 1500, retry: false });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const allCaptures = browserPreviews(snapshot);
  const views = (registry.data || []).filter(view => !dismissed.has(`${sessionId}:view:${view.id}`));
  const matches = (capture: BrowserPreview, view: BrowserLiveView) => capture.pageId ? capture.pageId === view.pageId : capture.url === view.url && (capture.owner === "Main conversation" ? !snapshot.workers.some(worker => worker.id === view.producerId) : snapshot.workers.some(worker => worker.id === view.producerId && worker.name === capture.owner));
  const previews = allCaptures.filter(preview => !dismissed.has(`${sessionId}:${preview.id}`) && !(registry.data || []).some(view => matches(preview, view)));
  if (!previews.length && !views.length) return emptyState ? <aside aria-label="Browser captures" className={className}>
    <div className="flex min-h-60 flex-col items-center justify-center px-6 py-10 text-center"><span className="mb-4 flex size-11 items-center justify-center rounded-[var(--radius-panel)] border border-border/60 bg-muted/30 text-muted-foreground"><Globe aria-hidden="true" className="size-5" /></span><p className="max-w-56 text-sm leading-6 text-foreground/80">Browser views appear here as agents browse</p><p className="mt-2 max-w-56 text-xs leading-5 text-muted-foreground">Live views connect when supported. Captures refresh after browser actions.</p></div>
  </aside> : null;
  return <aside aria-label="Browser captures" className={className}>
    <div className="mb-2 px-1 text-xs text-muted-foreground">Browser views</div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
      {views.map(view => <LiveBrowserCard key={`${client.backendId}:${sessionId}:${view.pageId}`} sessionId={sessionId} view={view} owner={snapshot.workers.find(worker => worker.id === view.producerId)?.name || "Main conversation"} fallback={allCaptures.find(capture => matches(capture, view))} onDismiss={() => setDismissed(previous => new Set(previous).add(`${sessionId}:view:${view.id}`))} />)}
      {previews.map(preview => <CaptureCard key={preview.id} preview={preview} onDismiss={() => setDismissed(previous => new Set(previous).add(`${sessionId}:${preview.id}`))} />)}
    </div>
  </aside>;
}
