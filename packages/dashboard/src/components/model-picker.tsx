import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Grid2X2, Search } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ModelIcon, ProviderIcon } from "@/components/provider-icon";

export interface CatalogModel { id: string; provider: string; price?: string; contextWindowTokens?: number | null; source?: string }
export interface CatalogProvider { id: string; label: string }
export function providerLabel(id: string): string {
  return ({ "chatgpt-plan": "ChatGPT plan", "chatgpt-codex": "ChatGPT / Codex", openai: "OpenAI API", anthropic: "Anthropic", google: "Google", openrouter: "OpenRouter", copilot: "GitHub Copilot", deepseek: "DeepSeek", xai: "xAI", "z-ai": "Z.ai", kimi: "Kimi", qwen: "Qwen", azure: "Azure OpenAI", opencode: "OpenCode" } as Record<string, string>)[id] ?? id;
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
  const [provider, setProvider] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => new Map(providers.map(item => [item.id, item.label])), [providers]);
  const groups = catalogProviderIds(models, diagnostics);
  const activeProvider = groups.includes(provider) ? provider : "";
  useEffect(() => { if (provider && !models.some(model => model.provider === provider) && !diagnostics.some(item => item.providerId === provider)) setProvider(""); }, [models, diagnostics, provider]);
  const matches = filterModels(models, query, activeProvider, providers);
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
    } else if (event.key === "ArrowLeft" && rail.current) {
      event.preventDefault(); event.stopPropagation(); rail.current.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    }
  }}>
    <div className="relative shrink-0 p-1 pb-2"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input ref={search} autoFocus className="h-8 rounded-[var(--radius-control)] pl-8 text-sm" data-1p-ignore data-lpignore="true" autoComplete="off" aria-label="Search models" placeholder="Search models and providers" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusModel(event.key === "ArrowUp"); }
      if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    }} /></div>
    <div className="flex min-h-0 flex-1">
      {groups.length > 1 && <div ref={rail} role="group" aria-label="Filter models by provider" className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border/60 py-1 pr-1" onKeyDown={event => {
        if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); if (matches.length) focusModel(); else search.current?.focus(); return; }
        if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); search.current?.focus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
        <Button type="button" variant="ghost" size="icon" title="All providers" aria-label="All providers" aria-pressed={!activeProvider} className={`shrink-0 ${!activeProvider ? "bg-muted text-foreground" : "text-muted-foreground"}`} onClick={() => setProvider("")}><Grid2X2 aria-hidden="true" className="size-4" /></Button>
        {groups.map(id => <Button key={id} type="button" variant="ghost" size="icon" title={labels.get(id) ?? providerLabel(id)} aria-label={`Filter ${labels.get(id) ?? providerLabel(id)} models`} aria-pressed={activeProvider === id} className={`shrink-0 ${activeProvider === id ? "bg-muted text-foreground" : "text-muted-foreground"}`} onClick={() => setProvider(id)}><ProviderIcon providerId={id} /></Button>)}
      </div>}
      <div ref={list} role="group" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-1" aria-label="Available models">
        {pending && <p role="status" className="px-3 py-3 text-xs text-muted-foreground">Loading models…</p>}
        {error && <p role="alert" className="px-3 py-3 text-xs text-muted-foreground">{error}</p>}
        {groups.filter(id => matches.some(model => model.provider === id)).map(id => <div key={id} role="group" aria-label={labels.get(id) ?? providerLabel(id)}><div className="ui-menu-section py-1.5">{labels.get(id) ?? providerLabel(id)}</div>{matches.filter(model => model.provider === id).map(model => <DropdownMenu.Item key={`${model.provider}:${model.id}`} data-model-option aria-label={`${model.id} ${labels.get(id) ?? providerLabel(id)}`} icon={<ModelIcon modelId={model.id} providerId={model.provider} />} selected={model.id === selected?.model && model.provider === selected?.providerId} aria-current={model.id === selected?.model && model.provider === selected?.providerId ? "true" : undefined} className="ui-menu-item ui-menu-item--detail focus-visible:ring-0 data-highlighted:bg-muted" onClick={() => onSelect(model)}><span className="min-w-0 flex-1"><span className="block truncate text-sm leading-5" title={model.id}>{model.id}</span><span className="ui-menu-secondary block truncate">{[model.source === "public-catalog" ? "Published catalog; access unverified" : undefined, contextLabel(model.contextWindowTokens), model.price].filter(Boolean).join(" · ") || (labels.get(id) ?? providerLabel(id))}</span></span></DropdownMenu.Item>)}</div>)}
        {!pending && !error && !matches.length && <p role="status" className="px-3 py-4 text-xs text-muted-foreground">{models.length ? "No models match your search." : emptyMessage}</p>}
        {!pending && diagnostics.filter(item => !activeProvider || item.providerId === activeProvider).map(item => <p key={item.providerId} role="status" className="px-3 py-2 text-xs text-muted-foreground">{labels.get(item.providerId) ?? providerLabel(item.providerId)}: {item.message}</p>)}
      </div>
    </div>
    {footer && <div className="shrink-0 border-t border-border/60 pt-1">{footer}</div>}
  </div>;
}
export function ModelPicker({ label = "Choose model", disabled, ...props }: Parameters<typeof ModelCatalog>[0] & { label?: string; disabled?: boolean }) {
  return <DropdownMenu><DropdownMenu.Trigger disabled={disabled} aria-label={label}><Button type="button" variant="outline" className="w-full min-w-0 justify-start gap-2 px-3 text-left font-normal">{props.selected?.model && <ModelIcon modelId={props.selected.model} providerId={props.selected.providerId ?? ""} />}<span className="min-w-0 flex-1 truncate">{props.selected?.model || label}</span><ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /></Button></DropdownMenu.Trigger><DropdownMenu.Content align="start" collisionPadding={12} className="console-model-picker ui-menu-surface flex w-[min(400px,calc(100vw-24px))] min-w-0 flex-col overflow-hidden font-sans"><ModelCatalog {...props} /></DropdownMenu.Content></DropdownMenu>;
}
