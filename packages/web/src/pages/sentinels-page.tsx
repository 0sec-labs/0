import { useEffect, useState } from "react";
import { usePendingGate } from "@/lib/pending-gate";
import { useBreadcrumbLabel } from "@/lib/breadcrumbs";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CapyAgentIcon } from "@/ui/icons/capy";
import { v } from "@/lib/vocabulary";
import { PageHeader } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { NotFound } from "@/ui/components/not-found";
import { useTeamAccess } from "@/components/team-access";
import { openNewAgent } from "@/lib/new-agent";
import { SentinelAvatar, SentinelStatusBadge } from "@/components/sentinels/sentinel-avatar";
import { AgentThread } from "@/components/sentinels/agent-thread";
import { SentinelAutomations, SentinelOverview, SentinelSettings } from "@/components/sentinels/sentinel-views";
import { GitHubWebhookControl } from "@/components/console-control/github-webhook-control";
import { AutomationEditor } from "@/components/automations/automation-editor";
import { NewAutomationDialog } from "@/components/automations/new-automation-dialog";
import { useAutomationRows } from "@/components/automations/use-automations";
import { relativeAge } from "@/components/automations/automation-model";
import { useSentinel, useSentinels } from "@/sentinels/api";
import { SENTINEL_VIEWS, orderSentinels, parseView, sentinelHref, type SentinelView } from "@/sentinels/model";

const VIEW_LABELS: Record<SentinelView, string> = { overview: "Overview", automations: "Automations", settings: "Settings" };

/** Index of Sentinels; also the landing target for "New Sentinel" from the command palette (`?new=1`). */
export function SentinelsPage() {
  const { supported, sentinels, isLoading, error, refetch } = useSentinels();
  const loading = usePendingGate(isLoading);
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const [newAutomation, setNewAutomation] = useState(false);
  const automations = useAutomationRows();
  const workflowId = search.get("workflow");
  // Old `?new=1` links open the one New agent dialog.
  const asksToCreate = search.get("new") === "1";
  useEffect(() => { if (asksToCreate) { openNewAgent(); setSearch(previous => { const next = new URLSearchParams(previous); next.delete("new"); return next; }, { replace: true }); } }, [asksToCreate, setSearch]);
  // Old "Set up" links carried the owner in the query; the automation now lives in that Agent's page.
  const legacyOwner = search.get("owner");
  if (legacyOwner && sentinels.some(item => item.id === legacyOwner)) return <Navigate to={sentinelHref(legacyOwner, "automations")} replace />;
  if (loading || isLoading) return <><LoadingState label="Loading" /></>;
  if (error) return <><ErrorState error={error} onRetry={() => void refetch()} /></>;
  if (!supported) return <><EmptyState title={v("{Sentinels} are not available")} body={v("This computer is older than {Sentinels}. Update it to use them.")} /></>;
  const rows = orderSentinels(sentinels);
  const nameOf = new Map(sentinels.map(item => [item.id, item.name]));
  const hrefFor = (id: string, owner?: string | null) => owner && nameOf.has(owner) ? `${sentinelHref(owner, "automations")}&workflow=${encodeURIComponent(id)}` : `/agents?workflow=${encodeURIComponent(id)}`;
  const owners = new Map(automations.definitions.map(item => [item.id, item.ownerSentinelId]));
  if (workflowId) return <><AutomationEditor workflowId={workflowId} onClose={() => setSearch(previous => { const next = new URLSearchParams(previous); next.delete("workflow"); return next; })} /></>;
  return <>
    <PageHeader title={v("{Sentinels}")} actions={!readOnly && rows.length > 0 ? <><Button type="button" variant="ghost" onClick={() => setNewAutomation(true)}>New automation</Button><Button type="button" variant="secondary" onClick={() => openNewAgent()}><CapyAgentIcon aria-hidden="true" />{v("New {sentinel}")}</Button></> : undefined} />
    {rows.length === 0 ? <EmptyState icon={<CapyAgentIcon />} title={v("No {sentinels} yet")} action={readOnly ? undefined : <Button type="button" variant="secondary" onClick={() => openNewAgent()}>{v("Create {a sentinel}")}</Button>} />
      : <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows.map(sentinel => <li key={sentinel.id} className="min-w-0"><Link to={sentinelHref(sentinel.id)} className="flex h-full min-w-0 flex-col gap-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-4 outline-none ui-row-hover focus-visible:outline-ring-inset">
          <span className="flex items-center gap-3"><SentinelAvatar sentinel={sentinel} size="sm" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{sentinel.name}</span><SentinelStatusBadge sentinel={sentinel} /></span>
          <span className="line-clamp-2 text-xs text-muted-foreground-1">{sentinel.mission || "No thread yet."}</span>
        </Link></li>)}
      </ul>}
    {automations.rows.length > 0 && <section aria-label="Automations" className="space-y-2">
      <h2 className="text-sm font-medium">Automations</h2>
      <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card">
        {automations.rows.map(item => { const owner = owners.get(item.id); return <li key={item.id}><Link to={hrefFor(item.id, owner)} className="flex items-center gap-3 px-4 py-3 text-sm outline-none ui-row-hover focus-visible:outline-ring-inset"><span className="min-w-0 flex-1 truncate">{item.name}</span><span className="hidden truncate text-xs text-muted-foreground-1 sm:block">{owner ? nameOf.get(owner) : ""}</span><span className="hidden w-40 truncate text-xs text-muted-foreground-1 md:block">{item.trigger}</span><span className="w-20 text-right text-xs tabular-nums text-muted-foreground-1">{relativeAge(item.lastRunAt, Date.now())}</span></Link></li>; })}
      </ul>
    </section>}
    {!readOnly && <GitHubWebhookControl />}
    <NewAutomationDialog open={newAutomation} onOpenChange={setNewAutomation} sentinels={sentinels} onCreated={(owner, id) => navigate(hrefFor(id, owner))} />
  </>;
}

/** One agent. By default its own thread; `?view=` opens the detail page: Overview (status, budget, threads, files), Automations, Settings. */
export function SentinelPage() {
  const { sentinelId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const query = useSentinel(sentinelId);
  useBreadcrumbLabel(query.data?.name);
  const view = parseView(search.get("view"));
  if (query.isLoading) return <><LoadingState label="Loading" variant="detail" /></>;
  if (query.error || !query.data) return <>{query.error instanceof Error && (query.error as { status?: number }).status !== 404 ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <NotFound section="sentinels" />}</>;
  const sentinel = query.data;
  if (view === null) return <AgentThread sentinel={sentinel} readOnly={readOnly} />;
  return <>
    <header className="flex items-center gap-4">
      <SentinelAvatar sentinel={sentinel} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h1 className="min-w-0 truncate font-sans text-[22px]/7 font-medium tracking-[-0.02em]">{sentinel.name}</h1><SentinelStatusBadge sentinel={sentinel} /></div>
        <p className="mt-1 text-sm text-muted-foreground">{sentinel.mission || "No job set yet."}</p>
      </div>
      <Button variant="secondary" size="sm" render={<Link to={sentinelHref(sentinel.id)} />}>Thread</Button>
    </header>
    <div className="no-scrollbar scroll-fade-x -mx-6 overflow-x-auto px-6 [--sf-right:24px] sm:[mask-image:none]"><Tabs value={view} onValueChange={next => setSearch(previous => { const params = new URLSearchParams(previous); params.set("view", String(next)); return params; }, { replace: true })}>
      <TabsList variant="line" aria-label="Agent views">{SENTINEL_VIEWS.map(item => <TabsTrigger key={item} value={item}>{VIEW_LABELS[item]}</TabsTrigger>)}</TabsList>
    </Tabs></div>
    <div role="region" aria-label={VIEW_LABELS[view]}>
      {view === "overview" && <SentinelOverview sentinel={sentinel} readOnly={readOnly} />}
      {view === "automations" && <SentinelAutomations sentinel={sentinel} readOnly={readOnly} />}
      {view === "settings" && <SentinelSettings key={sentinel.id} sentinel={sentinel} readOnly={readOnly} />}
    </div>
  </>;
}
