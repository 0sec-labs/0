import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { v } from "@/lib/vocabulary";
import { PageContent } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { useTeamAccess } from "@/components/team-access";
import { CreateSentinelDialog } from "@/components/sentinels/create-sentinel-dialog";
import { SentinelAvatar, SentinelStatusBadge } from "@/components/sentinels/sentinel-avatar";
import { SentinelFiles } from "@/components/sentinels/sentinel-files";
import { SentinelActivations, SentinelAutomations, SentinelOverview, SentinelSettings } from "@/components/sentinels/sentinel-views";
import { useSentinel, useSentinels } from "@/sentinels/api";
import { SENTINEL_VIEWS, orderSentinels, parseView, sentinelHref, type SentinelView } from "@/sentinels/model";

const VIEW_LABELS: Record<SentinelView, string> = { overview: "Overview", files: "Files", automations: "Automations", activations: "Activations", settings: "Settings" };

/** Index of Sentinels; also the landing target for "New Sentinel" from the command palette (`?new=1`). */
export function SentinelsPage() {
  const { supported, sentinels, isLoading, error } = useSentinels();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const creating = search.get("new") === "1";
  const setCreating = (open: boolean) => setSearch(previous => { const next = new URLSearchParams(previous); if (open) next.set("new", "1"); else next.delete("new"); return next; }, { replace: true });
  if (isLoading) return <PageContent><LoadingState label="Loading" /></PageContent>;
  if (error) return <PageContent><ErrorState error={error} /></PageContent>;
  if (!supported) return <PageContent><EmptyState title={v("{Sentinels} are not available")} body={v("This engine is older than {Sentinels}. Update it to use them.")} /></PageContent>;
  const rows = orderSentinels(sentinels);
  return <PageContent className="space-y-6">
    <header className="flex items-start justify-between gap-4">
      <div><h1 className="font-sans text-2xl font-medium tracking-tight">{v("{Sentinels}")}</h1><p className="mt-1 text-sm text-muted-foreground">{v("{Sentinels} watch your code and targets around the clock.")}</p></div>
      {!readOnly && <Button type="button" variant="accent" onClick={() => setCreating(true)}><Plus aria-hidden="true" />{v("New {sentinel}")}</Button>}
    </header>
    {rows.length === 0 ? <EmptyState title={v("No {sentinels} yet")} body={v("A {sentinel} is a named agent with a standing job. Start from a preset.")} action={readOnly ? undefined : <Button type="button" variant="accent" onClick={() => setCreating(true)}>{v("Create {a sentinel}")}</Button>} />
      : <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(sentinel => <li key={sentinel.id}><Link to={sentinelHref(sentinel.id)} className="flex h-full flex-col gap-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-4 outline-none hover:bg-card-hover focus-visible:outline-ring-inset">
          <span className="flex items-center gap-3"><SentinelAvatar sentinel={sentinel} size="sm" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{sentinel.name}</span><SentinelStatusBadge sentinel={sentinel} /></span>
          <span className="line-clamp-2 text-xs text-muted-foreground-1">{sentinel.mission || "No mission yet."}</span>
        </Link></li>)}
      </ul>}
    <CreateSentinelDialog open={creating} onOpenChange={setCreating} onCreated={sentinel => navigate(sentinelHref(sentinel.id))} />
  </PageContent>;
}

/** One Sentinel, laid out like a Capy Captain: profile header, then panel views. */
export function SentinelPage() {
  const { sentinelId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const query = useSentinel(sentinelId);
  const view = parseView(search.get("view"));
  if (query.isLoading) return <PageContent><LoadingState label="Loading" variant="detail" /></PageContent>;
  if (query.error || !query.data) return <PageContent><ErrorState error={query.error instanceof Error ? query.error : new Error("Sentinel not found.")} /></PageContent>;
  const sentinel = query.data;
  return <PageContent className="space-y-6">
    <header className="flex items-center gap-4">
      <SentinelAvatar sentinel={sentinel} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h1 className="min-w-0 truncate font-sans text-2xl font-medium tracking-tight">{sentinel.name}</h1><SentinelStatusBadge sentinel={sentinel} /></div>
        <p className="mt-1 text-sm text-muted-foreground">{sentinel.mission || "No mission yet."}</p>
      </div>
    </header>
    <Tabs value={view} onValueChange={next => setSearch(previous => { const params = new URLSearchParams(previous); if (next === "overview") params.delete("view"); else params.set("view", String(next)); return params; }, { replace: true })}>
      <TabsList variant="line" aria-label="Sentinel views">{SENTINEL_VIEWS.map(item => <TabsTrigger key={item} value={item}>{VIEW_LABELS[item]}</TabsTrigger>)}</TabsList>
    </Tabs>
    <div role="region" aria-label={VIEW_LABELS[view]}>
      {view === "overview" && <SentinelOverview sentinel={sentinel} readOnly={readOnly} />}
      {view === "files" && <SentinelFiles sentinelId={sentinel.id} readOnly={readOnly} />}
      {view === "automations" && <SentinelAutomations sentinel={sentinel} readOnly={readOnly} />}
      {view === "activations" && <SentinelActivations sentinel={sentinel} />}
      {view === "settings" && <SentinelSettings key={sentinel.id} sentinel={sentinel} readOnly={readOnly} />}
    </div>
  </PageContent>;
}
