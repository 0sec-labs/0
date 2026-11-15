import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Clock, SquareTerminal, Sparkles } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip } from "../ui/components/tooltip";
import { ModelIcon, ProviderIcon } from "@/components/provider-icon";
import { hideSnapshots, orderModels, orderProviders, rankSearch, searchRelevance } from "@/lib/model-order";
import { readRecentModels, recordRecentModel, resolveRecentModels } from "@/lib/last-model-choice";

export interface CatalogModel { id: string; provider: string; price?: string; contextWindowTokens?: number | null; source?: string; enabled?: boolean }
/** Rows are enabled unless the backend says otherwise (older hosts omit the flag). */
export const isModelEnabled = (model: Pick<CatalogModel, "enabled">): boolean => model.enabled !== false;
export const MODEL_OFF_HINT = "Turned off in Connections";
/** A per-role pick from the engine's recommendation catalog (see recommendModels). */
export interface RecommendedModel { role: string; label: string; why?: string; providerId: string; model: string }
export interface CatalogProvider { id: string; label: string }
/** Subscription-based OpenAI providers share the OpenAI mark; the rail tells them apart from the API provider. */
const isOpenAiBrand = (id: string) => ["chatgpt-plan", "chatgpt-codex", "codex", "chatgpt"].includes(id);
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
  /** Recommended picks that are listed and enabled, one per role, with the role they serve. */
  recommended: (CatalogModel & { roleLabel: string; why?: string })[];
  /** Last picks that still exist, most recent first. Empty while searching. */
  recent: CatalogModel[];
  groups: { id: string; label: string; models: CatalogModel[] }[];
}
/**
 * Picker layout as data: a "Recent" group, then one group per provider. Providers: selected first, recently used,
 * then most healthy models, failing last. Models: newest generation, flagship first, snapshots of listed aliases hidden.
 * While searching, name matches lead (prefix, word start, anywhere) and groups follow their best match.
 */
export function arrangeCatalog({ models, query = "", providers = [], diagnostics = [], selectedProvider, recents = [], recommended = [] }: {
  models: readonly CatalogModel[]; query?: string; providers?: readonly CatalogProvider[]; diagnostics?: readonly { providerId: string }[];
  selectedProvider?: string; recents?: readonly { providerId: string; model: string }[]; recommended?: readonly RecommendedModel[];
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
  // One row per model: when a single model serves several roles, the row names them all.
  const picks: CatalogArrangement["recommended"] = [];
  if (!searching) for (const pick of recommended) {
    const model = all.find(row => row.provider === pick.providerId && row.id === pick.model && isModelEnabled(row));
    if (!model) continue;
    const same = picks.find(item => item.provider === model.provider && item.id === model.id);
    if (same) { if (!same.roleLabel.split(", ").includes(pick.label)) same.roleLabel += `, ${pick.label}`; continue; }
    picks.push({ ...model, roleLabel: pick.label, why: pick.why });
  }
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const present = [...new Set(matches.map(model => model.provider))];
  // The rail keeps one order (healthiest first, then by name) so positions never shift between opens; Recent has its own entry.
  void selectedProvider;
  const order = orderProviders(all, present, { failing, label });
  const best = (id: string) => Math.min(...matches.filter(model => model.provider === id).map(model => searchRelevance(model, terms)));
  const ids = searching ? [...order].sort((a, b) => best(a) - best(b) || order.indexOf(a) - order.indexOf(b)) : order;
  return { recent, recommended: picks, groups: ids.map(id => { const rows = matches.filter(model => model.provider === id); return { id, label: label(id), models: searching ? rankSearch(rows, query) : orderModels(rows) }; }) };
}
/** The model Enter picks in the search box: the best enabled match, and only while a query is typed. */
export function firstEnabledMatch(layout: CatalogArrangement, searching: boolean): CatalogModel | undefined {
  if (!searching) return undefined;
  for (const group of layout.groups) { const hit = group.models.find(isModelEnabled); if (hit) return hit; }
  return undefined;
}
/** Visible reason for providers that are connected but could not list models. */
export function failingProvidersNotice(diagnostics: readonly { providerId: string }[], providers: readonly CatalogProvider[] = [], hasModels = true): string | undefined {
  const labels = new Map(providers.map(item => [item.id, item.label]));
  const names = [...new Set(diagnostics.map(item => item.providerId))].map(id => labels.get(id) ?? providerLabel(id));
  if (!names.length) return undefined;
  const list = names.join(", ");
  return hasModels ? `Couldn't load models from ${list}. Check Connections.` : `Couldn't load models. Check ${list} in Connections.`;
}
export interface CatalogConnection { id: string; label: string; connected: boolean; hint?: string }
export interface RailEntry { id: string; label: string; kind: "recommended" | "recent" | "models" | "empty" | "connect"; hint?: string }
/**
 * Left-rail entries: recents, providers with models, connected providers that have none yet (still listed,
 * never hidden), then providers that are not connected. Failing providers stay out entirely.
 */
export function railEntries({ layout, connections = [], failing = [], searching = false }: {
  layout: CatalogArrangement; connections?: readonly CatalogConnection[]; failing?: readonly string[]; searching?: boolean;
}): RailEntry[] {
  const out: RailEntry[] = [];
  if (layout.recommended.length > 0) out.push({ id: "recommended", label: "Recommended", kind: "recommended" });
  if (layout.recent.length > 0) out.push({ id: "recent", label: "Recent", kind: "recent" });
  for (const group of layout.groups) out.push({ id: group.id, label: group.label, kind: "models" });
  if (searching) return out;
  const seen = new Set(out.map(entry => entry.id));
  for (const item of connections) {
    if (seen.has(item.id) || failing.includes(item.id)) continue;
    out.push(item.connected ? { id: item.id, label: item.label, kind: "empty" } : { id: item.id, label: item.label, kind: "connect", ...(item.hint ? { hint: item.hint } : {}) });
  }
  return out;
}
export function ModelCatalog({ models, providers = [], selected, onSelect, backendId, pending, error, diagnostics = [], connections = [], onConnect, footer, emptyMessage = "No models available. Connect a provider to get started.", recommended = [], pendingProviders = [] }: {
  models: readonly CatalogModel[]; providers?: readonly CatalogProvider[]; selected?: { providerId?: string; model?: string }; onSelect: (model: CatalogModel) => void;
  /** When set, picks are remembered per backend and the last three show first under "Recent". */
  backendId?: string; pending?: boolean; error?: string; diagnostics?: readonly { providerId: string }[]; footer?: ReactNode; emptyMessage?: string;
  /** Known providers, so connected ones without models and unconnected ones can still be listed. */
  connections?: readonly CatalogConnection[]; onConnect?: (providerId: string) => void;
  /** Per-role picks from the host; shown first, and marked wherever the same model appears. */
  recommended?: readonly RecommendedModel[];
  /** Providers that are connected but still being discovered: shown as "Looking for models". */
  pendingProviders?: readonly string[];
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => new Map(providers.map(item => [item.id, item.label])), [providers]);
  const searching = query.trim().length > 0;
  const recents = useMemo(() => backendId ? readRecentModels(backendId) : [], [backendId]);
  const layout = useMemo(() => arrangeCatalog({ models, query, providers, diagnostics, selectedProvider: selected?.providerId, recents, recommended }), [models, query, providers, diagnostics, selected?.providerId, recents, recommended]);
  const notice = useMemo(() => failingProvidersNotice(diagnostics, providers, models.length > 0), [diagnostics, providers, models.length]);
  const failingIds = useMemo(() => diagnostics.map(item => item.providerId), [diagnostics]);
  const rail = useMemo(() => railEntries({ layout, connections, failing: failingIds, searching }), [layout, connections, failingIds, searching]);
  const [tab, setTab] = useState<string | undefined>();
  const selectedIsRecommended = layout.recommended.some(model => model.id === selected?.model && model.provider === selected?.providerId);
  // Open on Recommended unless the current choice lives elsewhere.
  const fallbackTab = (selectedIsRecommended || !selected?.providerId ? rail.find(entry => entry.kind === "recommended")?.id : undefined)
    ?? rail.find(entry => entry.id === selected?.providerId && entry.kind === "models")?.id ?? rail[0]?.id;
  const activeTab = rail.some(entry => entry.id === tab) ? tab : fallbackTab;
  const visibleCount = layout.recommended.length + layout.recent.length + layout.groups.reduce((sum, group) => sum + group.models.length, 0);
  const initialLoading = pending && models.length === 0;
  // Open on the current choice: bring its row into view without moving focus off the search field.
  useEffect(() => {
    const box = list.current, row = box?.querySelector<HTMLElement>("[aria-current=true]");
    if (!box || !row) return;
    const rowBox = row.getBoundingClientRect(), boxBox = box.getBoundingClientRect();
    if (rowBox.top < boxBox.top || rowBox.bottom > boxBox.bottom) box.scrollTop += rowBox.top - boxBox.top - (box.clientHeight - rowBox.height) / 2;
  }, [models.length > 0]);
  // Base UI moves focus to the first menu item as the popup opens from the keyboard; typing starts in the search field.
  useEffect(() => {
    // Once the user presses a key themselves, never pull focus back (slow machines fire the timer late).
    let touched = false;
    const touch = () => { touched = true; };
    const focusSearch = () => { if (!touched && !search.current?.contains(document.activeElement)) search.current?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", touch, true);
    const frame = requestAnimationFrame(focusSearch), timer = setTimeout(focusSearch, 80);
    return () => { document.removeEventListener("keydown", touch, true); cancelAnimationFrame(frame); clearTimeout(timer); };
  }, []);
  const choose = (model: CatalogModel) => {
    if (backendId) recordRecentModel(backendId, { providerId: model.provider, model: model.id });
    onSelect(model);
  };
  const focusModel = (last = false) => {
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-model-option]");
    const row = rows?.[last ? rows.length - 1 : 0];
    row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest" });
  };
  const recommendedKeys = useMemo(() => new Set(layout.recommended.map(model => `${model.provider}:${model.id}`)), [layout.recommended]);
  const row = (model: CatalogModel, section?: "recent" | "recommended") => {
    const roleLabel = (model as { roleLabel?: string }).roleLabel;
    // Inside the Recommended section the heading already says so; the pill only marks recommended models listed elsewhere.
    const marked = section !== "recommended" && recommendedKeys.has(`${model.provider}:${model.id}`);
    const label = labels.get(model.provider) ?? providerLabel(model.provider), on = isModelEnabled(model);
    const current = model.id === selected?.model && model.provider === selected?.providerId;
    return <DropdownMenu.Item key={`${section ?? "all"}:${model.provider}:${model.id}`} data-model-option disabled={!on} aria-label={`${section === "recent" ? "Recent: " : section === "recommended" ? "Recommended: " : ""}${model.id} ${label}`} icon={<ModelIcon modelId={model.id} providerId={model.provider} className="size-3.5 shrink-0" />} selected={current} aria-current={current ? "true" : undefined} className={`text-[13px] font-[450] tracking-[-0.01em] ${searching || !on || section === "recommended" ? "min-h-11 px-2 py-[5px]" : ""}`} onClick={() => { if (on) choose(model); }}><span className="min-w-0 flex-1"><span className="block truncate leading-5" title={model.id}>{model.id}</span>{!on ? <span className="block truncate text-[11px] leading-[14px] text-muted-foreground">{MODEL_OFF_HINT}</span> : section === "recommended" ? <span className="block truncate text-[11px] leading-[14px] text-muted-foreground" title={(model as { why?: string }).why}>{roleLabel} · {label}</span> : searching && <span className="block truncate text-[11px] leading-[14px] text-muted-foreground">{label}</span>}</span>{marked && <span className="ml-2 shrink-0 rounded-sm bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] px-1.5 text-[10px] font-medium leading-4 text-muted-foreground-1">Recommended</span>}</DropdownMenu.Item>;
  };
  const active = rail.find(entry => entry.id === activeTab);
  const paneBody = () => {
    if (!active) return null;
    if (active.kind === "recommended") return <div role="group" aria-label="Recommended">{layout.recommended.map(model => row(model, "recommended"))}</div>;
    if (active.kind === "recent") return <div role="group" aria-label="Recent">{layout.recent.map(model => row(model, "recent"))}</div>;
    const group = layout.groups.find(item => item.id === active.id);
    return <div role="group" aria-label={active.label}>
      {active.kind === "connect" && <div className="flex items-center gap-2 px-2 py-1.5"><p className="min-w-0 flex-1 text-xs text-muted-foreground-2">{active.hint ?? `Connect ${active.label} to use its models.`}</p><DropdownMenu.Item className="w-auto shrink-0 border-[0.5px] border-border-2 text-[13px] font-[450]" onClick={() => onConnect?.(active.id)}>Connect</DropdownMenu.Item></div>}
      {active.kind === "empty" && <p role="status" className="px-2 py-2 text-xs text-muted-foreground-2">{pending || pendingProviders.includes(active.id) ? "Looking for models…" : `No models listed for ${active.label} yet.`}</p>}
      {group?.models.map(model => row(model))}
    </div>;
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
      if (event.key === "Enter") { event.preventDefault(); // Click the row itself so the menu closes exactly as it does for a pointer pick.
        if (firstEnabledMatch(layout, searching)) list.current?.querySelector<HTMLElement>("[data-model-option]:not([data-disabled]):not([aria-disabled=true])")?.click(); }
      if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    }} /><div role="separator" className="-mx-1 my-1 h-px bg-border-1" /></div>
    <div className="flex min-h-0 flex-1">
      {rail.length > 0 && <div role="group" aria-label="Providers" className="flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto scroll-fade-y border-r border-border-1 pr-1">
        {rail.map(entry => <Tooltip key={entry.id} content={entry.label} side="right"><DropdownMenu.Item closeOnClick={false} aria-label={entry.label} aria-current={!searching && entry.id === activeTab ? "true" : undefined} className={`size-8 min-h-8 w-8 shrink-0 justify-center px-0 ${!searching && entry.id === activeTab ? "bg-[var(--popover-hover,color-mix(in_oklch,var(--foreground)_8%,transparent))]" : ""} ${entry.kind === "connect" ? "opacity-60" : ""}`} onClick={() => { setTab(entry.id); setQuery(""); }}>{entry.kind === "recommended" ? <Sparkles aria-hidden="true" className="size-4" /> : entry.kind === "recent" ? <Clock aria-hidden="true" className="size-4" /> : entry.id !== "openai" && isOpenAiBrand(entry.id) && rail.some(other => other.id === "openai") ? <SquareTerminal aria-hidden="true" className="size-4" /> : <ProviderIcon providerId={entry.id} className="size-4" />}</DropdownMenu.Item></Tooltip>)}
      </div>}
      <div ref={list} role="group" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scroll-fade-y pl-1" aria-label="Available models" aria-busy={initialLoading || undefined}>
        {initialLoading && <p role="status" className="px-3 py-3 text-xs text-muted-foreground">Loading</p>}
        {!error && notice && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
        {error && <p role="alert" className="px-3 py-3 text-xs text-muted-foreground">{error}</p>}
        {searching
          ? layout.groups.map(group => <div key={group.id} role="group" aria-label={group.label}><div className="mt-1 flex min-h-[22px] items-center px-2 text-xs font-medium text-muted-foreground-2 first:mt-0">{group.label}</div>{group.models.map(model => row(model))}</div>)
          : paneBody()}
        {!pending && !error && !visibleCount && !rail.length && <p role="status" className="px-3 py-4 text-xs text-muted-foreground">{models.length ? "No models match your search." : emptyMessage}</p>}
      </div>
    </div>
    {footer && <div className="shrink-0 border-t border-border-1 pt-1">{footer}</div>}
  </div>;
}
export function ModelPicker({ label = "Choose model", disabled, onOpen, triggerClassName = "w-full", ...props }: Parameters<typeof ModelCatalog>[0] & { label?: string; disabled?: boolean; onOpen?: () => void; triggerClassName?: string }) {
  return <DropdownMenu onOpenChange={open => { if (open) onOpen?.(); }}><DropdownMenu.Trigger disabled={disabled} aria-label={label}><Button type="button" variant="outline" className={`min-w-0 justify-start gap-2 px-3 text-left font-normal ${triggerClassName}`}>{props.selected?.model && <ModelIcon modelId={props.selected.model} providerId={props.selected.providerId ?? ""} />}<span className="min-w-0 flex-1 truncate">{props.selected?.model || label}</span><ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /></Button></DropdownMenu.Trigger><DropdownMenu.Content align="start" sideOffset={4} collisionPadding={12} className="max-w-[calc(100vw-24px)] max-h-[min(360px,var(--available-height,calc(100dvh-24px)))] overscroll-contain p-1 [&>.overflow-y-auto]:flex-1 [&>.overflow-y-auto]:scroll-py-1 flex w-[26rem] min-w-0 flex-col overflow-hidden font-sans"><ModelCatalog {...props} /></DropdownMenu.Content></DropdownMenu>;
}
