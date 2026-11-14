import { queryKeys } from "@/queries";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import {
  CapyArrowUpRightIcon as ExternalLink,
  CapyGlobeIcon as Globe,
  CapyExpandIcon as Maximize2,
  CapyCloseIcon as X,
} from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { browserPreviews, type BrowserPreview } from "../../browser-previews";
import { browserViews, useBrowserLive, type BrowserLiveView } from "../../use-browser-live";
import type { PanelViewComponent } from "../types";
import { browserItemLabel, browserItems, externalUrl, liveStatusLabel, selectBrowserKey } from "./agents-model";

const liveKey = (view: BrowserLiveView) => `live:${view.pageId}`;
const captureKey = (capture: BrowserPreview) => `capture:${capture.id}`;

function Empty() {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 px-6 text-center">
      <Globe aria-hidden="true" className="mb-2 size-8 text-muted-foreground-3 opacity-40" />
      <p className="max-w-xs text-balance text-xs text-muted-foreground-3">
        No browser views yet; they appear here as agents browse.
      </p>
    </div>
  );
}

function Frame({
  src,
  title,
  onExpand,
  placeholder,
}: {
  src?: string;
  title: string;
  onExpand?: () => void;
  placeholder: string;
}) {
  return (
    <div className="group relative flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-black/10">
      {src ? (
        <img src={src} alt={title} className="max-h-full w-full object-contain object-top" />
      ) : (
        <span className="m-auto px-4 text-xs text-muted-foreground-2">{placeholder}</span>
      )}
      {src && onExpand && (
        <button
          type="button"
          aria-label={`Expand: ${title}`}
          onClick={onExpand}
          className="absolute bottom-2 right-2 rounded bg-black/60 p-1.5 text-white opacity-0 outline-none transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-ring-inset"
        >
          <Maximize2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** Mounted only for the selected live view, so switching tabs (or hiding the panel) closes the stream. */
function LivePane({
  view,
  owner,
  fallback,
  sessionId,
  onUrl,
}: {
  view: BrowserLiveView;
  owner: string;
  fallback?: BrowserPreview;
  sessionId: string;
  onUrl: (url: string | undefined) => void;
}) {
  const [visible, setVisible] = useState(() => typeof document !== "undefined" && !document.hidden);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const { frame, status, reconnect } = useBrowserLive(view, visible, sessionId);
  const src = frame?.src || fallback?.src;
  const title = browserItemLabel({ kind: "live", ...view, id: view.id });
  const label = liveStatusLabel(status, Boolean(frame));
  const external = externalUrl(view.url);
  useEffect(() => {
    onUrl(view.url);
  }, [onUrl, view.url]);
  return (
    <>
      <Frame
        src={src}
        title={title}
        onExpand={() => setExpanded(true)}
        placeholder={view.liveAvailable ? "Waiting for browser frames…" : "Live view unavailable"}
      />
      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t-[0.5px] border-border-1 px-2 text-2xs text-muted-foreground-2">
        {status === "live" && frame && (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
        )}
        <span className="truncate">
          {label} · View only · {owner}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {view.liveAvailable && (
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Reconnect live view" onClick={reconnect}>
              <RotateCw className="size-3" />
            </Button>
          )}
          {external && (
            <Button variant="ghost" size="icon-xs" render={<a href={external} target="_blank" rel="noopener noreferrer" aria-label="Open page in a new tab" />}>
              <ExternalLink className="size-3" />
            </Button>
          )}
        </span>
      </footer>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="w-fit max-w-[95vw] p-3 pt-12 sm:max-w-[95vw]">
          <DialogTitle className="sr-only">{title}, browser view</DialogTitle>
          {src ? (
            <img src={src} alt={title} className="max-h-[82dvh] max-w-full object-contain" />
          ) : (
            <p className="p-8 text-sm text-muted-foreground">Waiting for browser frames…</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CapturePane({ capture, onUrl }: { capture: BrowserPreview; onUrl: (url: string | undefined) => void }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    onUrl(capture.url);
  }, [onUrl, capture.url]);
  useEffect(() => setFailed(false), [capture.src]);
  const external = externalUrl(capture.url);
  return (
    <>
      {failed ? (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground-2">Capture unavailable</div>
      ) : (
        <div className="group relative flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-black/10">
          <img
            src={capture.src}
            alt={capture.title}
            onError={() => setFailed(true)}
            className="max-h-full w-full object-contain object-top"
          />
          <button
            type="button"
            aria-label={`Expand capture: ${capture.title}`}
            onClick={() => setExpanded(true)}
            className="absolute bottom-2 right-2 rounded bg-black/60 p-1.5 text-white opacity-0 outline-none transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-ring-inset"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      )}
      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t-[0.5px] border-border-1 px-2 text-2xs text-muted-foreground-2">
        <span className="truncate">Captured screenshot · {capture.owner}</span>
        {external && (
          <Button variant="ghost" size="icon-xs" className="ml-auto" render={<a href={external} target="_blank" rel="noopener noreferrer" aria-label="Open page in a new tab" />}>
            <ExternalLink className="size-3" />
          </Button>
        )}
      </footer>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="w-fit max-w-[95vw] p-3 pt-12 sm:max-w-[95vw]">
          <DialogTitle className="sr-only">{capture.title}, captured screenshot</DialogTitle>
          <img src={capture.src} alt={capture.title} className="max-h-[82dvh] max-w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

export const BrowserView: PanelViewComponent = ({ snapshot, sessionId }) => {
  const { client } = useBackendApi();
  const id = snapshot?.session.id ?? sessionId;
  const registry = useQuery({
    queryKey: queryKeys.browserViews(client.backendId, id),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => {
      const response = await client.request(`/api/console/sessions/${encodeURIComponent(id!)}/browser/views`, {
        signal,
      });
      if ([404, 501].includes(response.status)) return [];
      if (!response.ok) throw new Error("Browser views unavailable");
      return browserViews(await response.json(), id);
    },
    refetchInterval: 1500,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | undefined>();
  const [url, setUrl] = useState<string | undefined>();
  const allCaptures = useMemo(() => (snapshot ? browserPreviews(snapshot) : []), [snapshot]);
  const workers = snapshot?.workers ?? [];
  const items = useMemo(
    () => browserItems(registry.data ?? [], allCaptures, workers, dismissed),
    [registry.data, allCaptures, workers, dismissed],
  );
  const keys = [...items.live.map(liveKey), ...items.captures.map(captureKey)];
  const active = selectBrowserKey(keys, selected);
  const view = items.live.find((item) => liveKey(item) === active);
  const capture = items.captures.find((item) => captureKey(item) === active);
  const ownerOf = (producerId: string) => workers.find((worker) => worker.id === producerId)?.name || "Main chat";
  const dismiss = (key: string) =>
    setDismissed((previous) =>
      new Set(previous).add(
        key.startsWith("live:")
          ? `view:${items.live.find((item) => liveKey(item) === key)?.id}`
          : key.slice("capture:".length),
      ),
    );

  if (!snapshot || !id)
    return (
      <div role="status" className="grid h-full place-items-center text-xs text-muted-foreground-2">
        Loading browser…
      </div>
    );
  if (!keys.length) return <Empty />;

  const tabs = [
    ...items.live.map((item) => ({
      key: liveKey(item),
      label: browserItemLabel({ kind: "live", ...item }),
      live: item.liveAvailable,
    })),
    ...items.captures.map((item) => ({
      key: captureKey(item),
      label: browserItemLabel({ kind: "capture", id: item.id, title: item.title, url: item.url, owner: item.owner }),
      live: false,
    })),
  ];
  return (
    <section aria-label="Browser views" className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b-[0.5px] border-border-1 px-1">
        <div
          role="tablist"
          aria-label="Browser views"
          className="scroll-fade-x flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className={cn(
                "group/tab flex h-6 max-w-40 shrink-0 items-center rounded text-xs",
                active === tab.key ? "bg-secondary text-foreground" : "text-muted-foreground-1 hover:bg-popover-hover",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active === tab.key}
                onClick={() => setSelected(tab.key)}
                className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 outline-none focus-visible:outline-ring-inset"
              >
                {tab.live ? (
                  <span aria-label="Live" className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                ) : (
                  <Globe aria-hidden="true" className="size-3 shrink-0 text-icon-muted" />
                )}
                <span className="truncate" title={tab.label}>
                  {tab.label}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Dismiss ${tab.label}`}
                onClick={() => dismiss(tab.key)}
                className="mr-0.5 hidden size-4 shrink-0 place-items-center rounded text-muted-foreground-2 hover:text-foreground group-hover/tab:grid focus-visible:grid"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div
        className="flex h-6 shrink-0 items-center gap-1.5 border-b-[0.5px] border-border-1 px-2 text-2xs tabular-nums text-muted-foreground-2"
        aria-label="Page address"
      >
        <Globe aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate" title={url}>
          {url ?? "No address"}
        </span>
      </div>
      {view ? (
        <LivePane
          key={`${client.backendId}:${id}:${view.pageId}`}
          sessionId={id}
          view={view}
          owner={ownerOf(view.producerId)}
          fallback={allCaptures.find((item) => (item.pageId ? item.pageId === view.pageId : item.url === view.url))}
          onUrl={setUrl}
        />
      ) : capture ? (
        <CapturePane key={capture.id} capture={capture} onUrl={setUrl} />
      ) : null}
    </section>
  );
};
