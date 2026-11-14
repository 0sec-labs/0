import { useMemo, useState } from "react";
import { CapyCheckIcon as Check, CapyChevronRightIcon as ChevronRight, CapyCopyIcon as Copy } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { findingViewId, type PanelViewComponent } from "../types";
import { buildEvidence, evidenceArtifactCount, type EvidenceArtifact, type EvidenceFilter, type EvidenceItem } from "./evidence-model";
import { SeverityDot } from "./findings";
import { useChatFindings } from "./use-chat-findings";

const FILTERS: readonly { value: EvidenceFilter; label: string }[] = [{ value: "all", label: "All" }, { value: "traffic", label: "Requests/responses" }, { value: "analysis", label: "Analysis" }];

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch { setState("failed"); }
    setTimeout(() => setState("idle"), 1500);
  };
  return <Button variant="ghost" size="icon-sm" aria-label={state === "failed" ? "Copy failed" : state === "copied" ? "Copied" : `Copy ${label}`} title={state === "failed" ? "Copy failed" : "Copy"} onClick={() => void copy()}>{state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>;
}

export function EvidenceArtifactRow({ artifact, defaultOpen = false }: { artifact: EvidenceArtifact; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const mono = artifact.kind !== "analysis";
  return <div className="border-t-[0.5px] border-border-1 first:border-t-0">
    <div className="flex h-7 items-center gap-1 pr-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:outline-ring-inset">
        <ChevronRight className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <span className="font-medium text-foreground">{artifact.label}</span>
        <span className="text-2xs tabular-nums text-muted-foreground-2">{artifact.lineCount} {artifact.lineCount === 1 ? "line" : "lines"}</span>
      </button>
      <CopyButton text={artifact.text} label={artifact.label.toLowerCase()} />
    </div>
    {open && <pre tabIndex={0} className={cn("max-h-72 overflow-auto scroll-fade-y whitespace-pre-wrap break-words px-3 pb-2 text-xs leading-5", mono ? "font-mono" : "font-sans text-muted-foreground")}>{artifact.text}</pre>}
  </div>;
}

const SIGNAL_LABEL = { weak: "Weak signal", medium: "Medium signal", strong: "Strong signal" } as const;

export function EvidenceCard({ item, onOpen }: { item: EvidenceItem; onOpen?: () => void }) {
  return <article aria-label={`Evidence for ${item.title}`} className="rounded-lg border-[0.5px] border-border-1 bg-card">
    <header className="flex h-8 items-center gap-2 px-2">
      <SeverityDot severity={item.severity} />
      {onOpen ? <button type="button" onClick={onOpen} title={item.title} className="min-w-0 flex-1 truncate text-left text-xs font-medium outline-none hover:underline focus-visible:outline-ring-inset">{item.title}</button> : <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.title}</span>}
      {item.signal && <span className="shrink-0 rounded-full bg-secondary px-1.5 text-2xs text-muted-foreground">{SIGNAL_LABEL[item.signal]}</span>}
    </header>
    <div className="border-t-[0.5px] border-border-1">{item.artifacts.map(artifact => <EvidenceArtifactRow key={artifact.kind} artifact={artifact} defaultOpen={artifact.kind === "analysis"} />)}</div>
  </article>;
}

export const EvidenceView: PanelViewComponent = ({ snapshot, sessionId, openView }) => {
  const { findings, loading, error, retry } = useChatFindings(sessionId, snapshot?.session.savedId);
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const items = useMemo(() => buildEvidence(findings, filter), [findings, filter]);
  const total = useMemo(() => evidenceArtifactCount(buildEvidence(findings)), [findings]);
  return <section aria-label="Evidence from this chat" className="flex h-full min-h-0 flex-col">
    <div role="group" aria-label="Evidence filter" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b-[0.5px] border-border-1 px-2 py-1.5">
      {FILTERS.map(option => <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)} className={cn("inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs transition-colors outline-none focus-visible:outline-ring-inset", filter === option.value ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}>{option.label}</button>)}
      {total > 0 && <span className="ml-auto pl-2 text-2xs tabular-nums text-muted-foreground-2">{total}</span>}
    </div>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scroll-fade-y p-2">
      {error ? <div role="status" className="flex items-center gap-2 py-3 text-xs text-muted-foreground">Couldn't load evidence.<Button variant="ghost" size="sm" onClick={retry}>Retry</Button></div>
        : loading && !findings.length ? <p role="status" className="py-3 text-xs text-muted-foreground">Loading…</p>
        : !items.length ? <p className="px-4 py-10 text-center text-xs text-muted-foreground">{total ? "No evidence matches this filter." : "No evidence captured yet."}</p>
        : items.map(item => <EvidenceCard key={item.fingerprint} item={item} onOpen={() => openView(findingViewId(item.fingerprint), { title: item.title })} />)}
    </div>
  </section>;
};
