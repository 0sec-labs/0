import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "../ui/components/skeleton";
import { ModelIcon } from "@/components/provider-icon";
import { hideSnapshots, orderModels, orderProviders, rankSearch, searchRelevance } from "@/lib/model-order";
import { readRecentModels, recordRecentModel, resolveRecentModels } from "@/lib/last-model-choice";

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
export interface CatalogArrangement {
  /** Last picks that still exist, most recent first. Empty while searching. */
  recent: CatalogModel[];
  groups: { id: string; label: string; models: CatalogModel[] }[];
}
/**
 * Picker layout as data: a "Recent" group, then one group per provider. Providers: selected first, recently used,
 * then most healthy models, failing last. Models: newest generation, flagship first, snapshots of listed aliases hidden.
 * While searching, name matches lead (prefix, word start, anywhere) and groups follow their best match.
 */
export function arrangeCatalog({ models, query = "", providers = [], diagnostics = [], selectedProvider, recents = [] }: {
  models: readonly CatalogModel[]; query?: string; providers?: readonly CatalogProvider[]; diagnostics?: readonly { providerId: string }[];
  selectedProvider?: string; recents?: readonly { providerId: string; model: string }[];
}): CatalogArrangement {
  const labels = new Map(providers.map(item => [item.id, item.label]));
  const label = (id: string) => labels.get(id) ?? providerLabel(id);
  const searching = query.trim().length > 0;
  // Failing providers simply do not appear; Connections and Settings > Models explain what is wrong.
  const failing = new Set(diagnostics.map(item => item.providerId));
  const all = filterModels(models.filter(model => !failing.has(model.provider)), "", "", providers);
  // A query that looks like a date asks for a snapshot on purpose.
  const listable = searching && /\d{4}/.test(query) ? all : hideSnapshots(all);
  const matches = searching ? filterModels(listable, query, "", providers) : listable;
  const recent = searching ? [] : resolveRecentModels(recents, all);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const present = [...new Set(matches.map(model => model.provider))];
  const order = orderProviders(all, present, { selectedProvider, recentProviders: recent.map(model => model.provider), failing, label });
  const best = (id: string) => Math.min(...matches.filter(model => model.provider === id).map(model => searchRelevance(model, terms)));
  const ids = searching ? [...order].sort((a, b) => best(a) - best(b) || order.indexOf(a) - order.indexOf(b)) : order;
  return { recent, groups: ids.map(id => { const rows = matches.filter(model => model.provider === id); return { id, label: label(id), models: searching ? rankSearch(rows, query) : orderModels(rows) }; }) };
}
function contextLabel(value?: number | null) {
  return value && value > 0 ? `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)} context` : undefined;
}
export function ModelCatalog({ models, providers = [], selected, onSelect, backendId, pending, error, diagnostics = [], footer, emptyMessage = "No models available. Connect a provider to get started." }: {
  models: readonly CatalogModel[]; providers?: readonly CatalogProvider[]; selected?: { providerId?: string; model?: string }; onSelect: (model: CatalogModel) => void;
  /** When set, picks are remembered per backend and the last three show first under "Recent". */
  backendId?: string; pending?: boolean; error?: string; diagnostics?: readonly { providerId: string }[]; footer?: ReactNode; emptyMessage?: string;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => new Map(providers.map(item => [item.id, item.label])), [providers]);
  const searching = query.trim().length > 0;
  const recents = useMemo(() => backendId ? readRecentModels(backendId) : [], [backendId]);
  const layout = useMemo(() => arrangeCatalog({ models, query, providers, diagnostics, selectedProvider: selected?.providerId, recents }), [models, query, providers, diagnostics, selected?.providerId, recents]);
  const visibleCount = layout.recent.length + layout.groups.reduce((sum, group) => sum + group.models.length, 0);
  const initialLoading = pending && models.length === 0;
  // Open on the current choice: bring its row into view without moving focus off the search field.
  useEffect(() => {
    const box = list.current, row = box?.querySelector<HTMLElement>("[aria-current=true]");
    if (!box || !row) return;
    const rowBox = row.getBoundingClientRect(), boxBox = box.getBoundingClientRect();
    if (rowBox.top < boxBox.top || rowBox.bottom > boxBox.bottom) box.scrollTop += rowBox.top - boxBox.top - (box.clientHeight - rowBox.height) / 2;
  }, [models.length > 0]);
  const choose = (model: CatalogModel) => {
    if (backendId) recordRecentModel(backendId, { providerId: model.provider, model: model.id });
    onSelect(model);
  };
  const focusModel = (last = false) => {
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-model-option]");
    const row = rows?.[last ? rows.length - 1 : 0];
    row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest" });
  };
  const row = (model: CatalogModel, section?: "recent") => {
    const label = labels.get(model.provider) ?? providerLabel(model.provider), on = isModelEnabled(model);
    const current = model.id === selected?.model && model.provider === selected?.providerId;
    return <DropdownMenu.Item key={`${section ?? "all"}:${model.provider}:${model.id}`} data-model-option disabled={!on} aria-label={`${section ? "Recent: " : ""}${model.id} ${label}`} icon={<ModelIcon modelId={model.id} providerId={model.provider} className="size-3.5 shrink-0" />} selected={current} aria-current={current ? "true" : undefined} className={`text-[13px] font-[450] tracking-[-0.01em] ${searching || !on ? "min-h-11 px-2 py-[5px]" : ""}`} onClick={() => { if (on) choose(model); }}><span className="min-w-0 flex-1"><span className="block truncate leading-5" title={model.id}>{model.id}</span>{!on ? <span className="block truncate text-[11px] leading-[14px] text-muted-foreground">{MODEL_OFF_HINT}</span> : searching && <span className="block truncate text-[11px] leading-[14px] text-muted-foreground">{[model.source === "public-catalog" ? "Published catalog; access unverified" : undefined, contextLabel(model.contextWindowTokens), model.price].filter(Boolean).join(" · ") || label}</span>}</span></DropdownMenu.Item>;
  };
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden" onKeyDownCapture={event => {
    const row = (event.target as HTMLElement).closest("[data-model-option]");
    if (!row) return;
    const rows = list.current?.querySelectorAll("[data-model-option]");
    if ((event.key === "ArrowUp" && row === rows?.[0]) || (event.key === "ArrowDown" && row === rows?.[rows.length - 1])) {
      event.preventDefault(); event.stopPropagation(); search.current?.focus();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      // Typing anywhere in the list continues in the search field.
      event.preventDefault(); event.stopPropagation(); setQuery(value => value + event.key); search.current?.focus();
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
        {layout.recent.length > 0 && <div role="group" aria-label="Recent"><div className="mt-1 flex min-h-[22px] items-center px-2 text-xs font-medium text-muted-foreground-2 first:mt-0">Recent</div>{layout.recent.map(model => row(model, "recent"))}</div>}
        {layout.groups.map(group => <div key={group.id} role="group" aria-label={group.label}><div className="mt-1 flex min-h-[22px] items-center px-2 text-xs font-medium text-muted-foreground-2 first:mt-0">{group.label}</div>{group.models.map(model => row(model))}</div>)}
        {!pending && !error && !visibleCount && <p role="status" className="px-3 py-4 text-xs text-muted-foreground">{models.length ? "No models match your search." : emptyMessage}</p>}
      </div>
    </div>
    {footer && <div className="shrink-0 border-t border-border-1 pt-1">{footer}</div>}
  </div>;
}
export function ModelPicker({ label = "Choose model", disabled, onOpen, triggerClassName = "w-full", ...props }: Parameters<typeof ModelCatalog>[0] & { label?: string; disabled?: boolean; onOpen?: () => void; triggerClassName?: string }) {
  return <DropdownMenu onOpenChange={open => { if (open) onOpen?.(); }}><DropdownMenu.Trigger disabled={disabled} aria-label={label}><Button type="button" variant="outline" className={`min-w-0 justify-start gap-2 px-3 text-left font-normal ${triggerClassName}`}>{props.selected?.model && <ModelIcon modelId={props.selected.model} providerId={props.selected.providerId ?? ""} />}<span className="min-w-0 flex-1 truncate">{props.selected?.model || label}</span><ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /></Button></DropdownMenu.Trigger><DropdownMenu.Content align="start" sideOffset={4} collisionPadding={12} className="max-w-[calc(100vw-24px)] max-h-[min(360px,var(--available-height,calc(100dvh-24px)))] overscroll-contain p-1 [&>.overflow-y-auto]:flex-1 [&>.overflow-y-auto]:scroll-py-1 flex w-80 min-w-0 flex-col overflow-hidden font-sans"><ModelCatalog {...props} /></DropdownMenu.Content></DropdownMenu>;
}
