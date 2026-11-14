import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/ui/components/skeleton";
import { MermaidDiagram } from "../formatted-code";
import { downloadText, serializeSvg, slugify, specToText, tableToCsv } from "./export";
import { describeViz, parseVizFence } from "./parse";
import type { VizSpec } from "./types";

const GraphView = lazy(() => import("./graph-view"));
const ChartView = lazy(() => import("./chart-view"));
const TimelineView = lazy(() => import("./timeline-view"));
const TableView = lazy(() => import("./table-view"));

export function VizSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2 p-4">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-28 w-full" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** A failed lazy chunk must degrade to readable source, never blank the transcript. */
class ViewBoundary extends Component<{ spec: VizSpec; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <pre className="overflow-x-auto p-3 font-mono text-xs"><code>{specToText(this.props.spec)}</code></pre>
      : this.props.children;
  }
}

function VizBody({ spec, expanded }: { spec: VizSpec; expanded?: boolean }) {
  switch (spec.kind) {
    case "graph": return <GraphView spec={spec} expanded={expanded} />;
    case "chart": return <ChartView spec={spec} expanded={expanded} />;
    case "timeline": return <TimelineView spec={spec} expanded={expanded} />;
    case "table": return <TableView spec={spec} expanded={expanded} />;
    case "mermaid": return <MermaidDiagram source={spec.source} streaming={false} />;
  }
}

function useTransientFlag(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [on, () => { setOn(true); clearTimeout(timer.current); timer.current = window.setTimeout(() => setOn(false), 1800); }];
}

/**
 * Inline visualization card: title, toolbar (copy spec, download SVG/CSV, expand),
 * lazy-loaded renderer. `spec` must come from `validateViz`/`parseVizFence`;
 * pass `streaming` while the producing text is still arriving to show a skeleton.
 */
export function Visualization({ spec, streaming = false, className }: { spec: VizSpec; streaming?: boolean; className?: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [copied, flashCopied] = useTransientFlag();
  const [expanded, setExpanded] = useState(false);
  // Renderers draw asynchronously and mermaid can fail, so track whether an SVG actually exists to download.
  const [hasSvg, setHasSvg] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const update = () => setHasSvg(Boolean(node.querySelector("svg")));
    update();
    const observer = new MutationObserver(update);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [spec]);
  const canDownload = spec.kind === "table" || hasSvg;
  const summary = describeViz(spec);
  const name = slugify(spec.title, spec.kind);
  const copy = async () => {
    try { await navigator.clipboard.writeText(specToText(spec)); flashCopied(); } catch { /* clipboard unavailable */ }
  };
  const download = () => {
    if (spec.kind === "table") return downloadText(`${name}.csv`, tableToCsv(spec), "text/csv");
    const svg = body.current?.querySelector("svg");
    if (svg instanceof SVGSVGElement) downloadText(`${name}.svg`, serializeSvg(svg), "image/svg+xml");
  };
  const view = (isExpanded: boolean) => (
    <ViewBoundary spec={spec}>
      <Suspense fallback={<VizSkeleton label={`Loading ${spec.kind}`} />}><VizBody spec={spec} expanded={isExpanded} /></Suspense>
    </ViewBoundary>
  );
  return (
    <figure data-slot="visualization" data-kind={spec.kind} className={`group/viz relative my-3 min-w-0 overflow-hidden rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card${className ? ` ${className}` : ""}`}>
      <div className="flex items-center gap-2 px-3 pt-2">
        <figcaption className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{spec.title ?? `${spec.kind[0]!.toUpperCase()}${spec.kind.slice(1)}`}</figcaption>
        {!streaming && (
          <div role="toolbar" aria-label="Visualization actions" className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/viz:opacity-100 group-focus-within/viz:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
            <Button type="button" variant="ghost" size="xs" onClick={() => void copy()} aria-label={spec.kind === "mermaid" ? "Copy diagram source" : "Copy spec"}>{copied ? <Check /> : <Copy />}<span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span></Button>
            <Button type="button" variant="ghost" size="xs" onClick={download} disabled={!canDownload} title={canDownload ? undefined : "Nothing to download: this visualization did not render"} aria-label={spec.kind === "table" ? "Download CSV" : "Download SVG"}><Download /></Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded(true)} aria-label="Expand"><Maximize2 /></Button>
          </div>
        )}
      </div>
      <div ref={body} data-slot="viz-body" className="min-w-0 bg-card py-1">
        {streaming ? <VizSkeleton label={`Rendering ${spec.kind} when complete`} /> : view(false)}
      </div>
      {!streaming && <p className="px-3 pb-2 text-xs text-muted-foreground">{summary}</p>}
      {expanded && (
        <Dialog open onOpenChange={setExpanded}>
          <DialogContent className="max-h-[92vh] w-[min(96vw,1100px)] max-w-none overflow-auto sm:max-w-none">
            <DialogTitle>{spec.title ?? spec.kind}</DialogTitle>
            <DialogDescription>{summary}</DialogDescription>
            <div data-slot="viz-body" className="min-w-0 bg-card">{view(true)}</div>
          </DialogContent>
        </Dialog>
      )}
    </figure>
  );
}

/** Markdown fence entry point: skeleton while streaming, plain `fallback` code block on any parse error. */
export function VizFence({ language, source, streaming, fallback }: { language: string; source: string; streaming: boolean; fallback: ReactNode }) {
  const parsed = useMemo(() => (streaming ? undefined : parseVizFence(language, source)), [language, source, streaming]);
  if (streaming || !parsed) {
    const kind = language === "attack-graph" ? "graph" : language;
    return (
      <figure data-slot="visualization" className="my-3 min-w-0 overflow-hidden rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card">
        <VizSkeleton label={`Rendering ${kind} when complete`} />
      </figure>
    );
  }
  if (!parsed.ok) {
    return <>{language !== "mermaid" && <p role="status" className="mt-3 text-xs text-muted-foreground">Showing source: {parsed.reason}.</p>}{fallback}</>;
  }
  return <Visualization spec={parsed.spec} />;
}
