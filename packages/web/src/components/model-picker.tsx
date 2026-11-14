import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "../ui/components/skeleton";
import { ModelIcon } from "@/components/provider-icon";

export interface CatalogModel { id: string; provider: string; price?: string; contextWindowTokens?: number | null; source?: string; enabled?: boolean }
/** Rows are enabled unless the backend says otherwise (older hosts omit the flag). */
export const isModelEnabled = (model: Pick<CatalogModel, "enabled">): boolean => model.enabled !== false;
export const MODEL_OFF_HINT = "Turned off in Connections";
export interface CatalogProvider { id: string; label: string }
export function providerLabel(id: string): string {
  return ({ "chatgpt-plan": "ChatGPT plan", "chatgpt-codex": "ChatGPT / Codex", openai: "OpenAI API", anthropic: "Anthropic", google: "Google", openrouter: "OpenRouter", deepseek: "DeepSeek", xai: "xAI", "z-ai": "Z.ai", kimi: "Kimi", qwen: "Qwen", azure: "Azure OpenAI", opencode: "OpenCode", together: "Together AI" } as Record<string, string>)[id] ?? id;
}
export function catalogProviderIds(models: readonly CatalogModel[], diagnostics: readonly { providerId: string }[] = []): string[] {
  return [...new Set([...models.map(model => model.provider), ...diagnostics.map(item => item.providerId)])];
}
export function filterModels(models: readonly CatalogModel[], query: string, provider: string, providers: readonly CatalogProvider[] = []): CatalogModel[] {
  const labels = new Map(providers.map(item => [item.id, item.label]));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const unique = new Map<string, CatalogModel>();
  for (const model of models) {
    const key = `${model.provider}:${model.id}`;
    if (!unique.has(key) || model.source === "account") unique.set(key, model);
  }
  return [...unique.values()].filter(model => (!provider || model.provider === provider) && terms.every(term => `${model.id} ${model.provider} ${providerLabel(model.provider)} ${labels.get(model.provider) ?? ""}`.toLowerCase().includes(term)));
}
function contextLabel(value?: number | null) {
  return value && value > 0 ? `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)} context` : undefined;
}
export function ModelCatalog({ models, providers = [], selected, onSelect, pending, error, diagnostics = [], footer, emptyMessage = "No models available. Connect a provider to get started." }: {
  models: readonly CatalogModel[]; providers?: readonly CatalogProvider[]; selected?: { providerId?: string; model?: string }; onSelect: (model: CatalogModel) => void;
  pending?: boolean; error?: string; diagnostics?: readonly { providerId: string; message: string }[]; footer?: ReactNode; emptyMessage?: string;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => new Map(providers.map(item => [item.id, item.label])), [providers]);
  const groups = catalogProviderIds(models, diagnostics);
  const matches = filterModels(models, query, "", providers);
  const searching = query.trim().length > 0;
  const initialLoading = pending && models.length === 0;
  const focusModel = (last = false) => {
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-model-option]");
    const row = rows?.[last ? rows.length - 1 : 0];
    row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest" });
  };
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden" onKeyDownCapture={event => {
    const row = (event.target as HTMLElement).closest("[data-model-option]");
    if (!row) return;
    if (event.key === "ArrowUp" && row === list.current?.querySelector("[data-model-option]")) {
      event.preventDefault(); event.stopPropagation(); search.current?.focus();
    }
  }}>
    <div className="shrink-0"><input ref={search} autoFocus type="text" className="block h-7 w-full bg-transparent px-2 text-[13px] font-[450] tracking-[-0.01em] text-foreground outline-none placeholder:text-muted-foreground-3" data-1p-ignore data-lpignore="true" autoComplete="off" aria-label="Search models" placeholder="Search models" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusModel(event.key === "ArrowUp"); }
      if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    }} /><div role="separator" className="-mx-1 my-1 h-px bg-border-1" /></div>
    <div className="flex min-h-0 flex-1">
      <div ref={list} role="group" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scroll-fade-y" aria-label="Available models" aria-busy={initialLoading || undefined}>
        {initialLoading && <div role="status" aria-label="Loading models" className="space-y-1 py-2">
          <span className="sr-only">Loading models…</span>
          <div aria-hidden="true"><Skeleton className="mx-3 mb-3 h-3 w-24" />{[0, 1, 2, 3, 4].map(row => <div key={row} className="flex items-center gap-3 px-3 py-2.5"><Skeleton className="size-4 shrink-0 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className={`h-3 ${row % 2 ? "w-36" : "w-44"}`} /><Skeleton className="h-2.5 w-52 max-w-full" /></div></div>)}</div>
        </div>}
        {error && <p role="alert" className="px-3 py-3 text-xs text-muted-foreground">{error}</p>}
        {groups.filter(id => matches.some(model => model.provider === id)).map(id => <div key={id} role="group" aria-label={labels.get(id) ?? providerLabel(id)}><div className="mt-1 flex min-h-[22px] items-center px-2 text-xs font-medium text-muted-foreground-2 first:mt-0">{labels.get(id) ?? providerLabel(id)}</div>{matches.filter(model => model.provider === id).map(model => <DropdownMenu.Item key={`${model.provider}:${model.id}`} data-model-option disabled={!isModelEnabled(model)} aria-label={`${model.id} ${labels.get(id) ?? providerLabel(id)}`} icon={<ModelIcon modelId={model.id} providerId={model.provider} className="size-3.5 shrink-0" />} selected={model.id === selected?.model && model.provider === selected?.providerId} aria-current={model.id === selected?.model && model.provider === selected?.providerId ? "true" : undefined} className={`text-[13px] font-[450] tracking-[-0.01em] ${searching || !isModelEnabled(model) ? "min-h-11 px-2 py-[5px]" : ""}`} onClick={() => { if (isModelEnabled(model)) onSelect(model); }}><span className="min-w-0 flex-1"><span className="block truncate leading-5" title={model.id}>{model.id}</span>{!isModelEnabled(model) ? <span className="block truncate text-[11px] leading-[14px] text-muted-foreground">{MODEL_OFF_HINT}</span> : searching && <span className="block truncate text-[11px] leading-[14px] text-muted-foreground">{[model.source === "public-catalog" ? "Published catalog; access unverified" : undefined, contextLabel(model.contextWindowTokens), model.price].filter(Boolean).join(" · ") || (labels.get(id) ?? providerLabel(id))}</span>}</span></DropdownMenu.Item>)}</div>)}
        {!pending && !error && !matches.length && <p role="status" className="px-3 py-4 text-xs text-muted-foreground">{models.length ? "No models match your search." : emptyMessage}</p>}
        {!pending && diagnostics.map(item => <p key={item.providerId} role="status" title={item.message} className="px-3 py-2 text-xs text-muted-foreground">{labels.get(item.providerId) ?? providerLabel(item.providerId)}: Connection needs attention. <Link to="/connections" className="underline underline-offset-2 hover:text-foreground">Open Connections</Link></p>)}
      </div>
    </div>
    {footer && <div className="shrink-0 border-t border-border-1 pt-1">{footer}</div>}
  </div>;
}
export function ModelPicker({ label = "Choose model", disabled, onOpen, triggerClassName = "w-full", ...props }: Parameters<typeof ModelCatalog>[0] & { label?: string; disabled?: boolean; onOpen?: () => void; triggerClassName?: string }) {
  return <DropdownMenu onOpenChange={open => { if (open) onOpen?.(); }}><DropdownMenu.Trigger disabled={disabled} aria-label={label}><Button type="button" variant="outline" className={`min-w-0 justify-start gap-2 px-3 text-left font-normal ${triggerClassName}`}>{props.selected?.model && <ModelIcon modelId={props.selected.model} providerId={props.selected.providerId ?? ""} />}<span className="min-w-0 flex-1 truncate">{props.selected?.model || label}</span><ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /></Button></DropdownMenu.Trigger><DropdownMenu.Content align="start" sideOffset={4} collisionPadding={12} className="max-w-[calc(100vw-24px)] max-h-[min(360px,var(--available-height,calc(100dvh-24px)))] overscroll-contain p-1 [&>.overflow-y-auto]:flex-1 [&>.overflow-y-auto]:scroll-py-1 flex w-80 min-w-0 flex-col overflow-hidden font-sans"><ModelCatalog {...props} /></DropdownMenu.Content></DropdownMenu>;
}
