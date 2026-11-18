import { useEffect, useState } from "react";
import { usePendingGate } from "@/lib/pending-gate";
import { useBreadcrumbLabel } from "@/lib/breadcrumbs";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CapyAgentIcon } from "@/ui/icons/capy";
import { v } from "@/lib/vocabulary";
import { PageHeader, usePageVariant } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { NotFound } from "@/ui/components/not-found";
import { useTeamAccess } from "@/components/team-access";
import { openNewAgent } from "@/lib/new-agent";
import { SentinelAvatar, SentinelStatusBadge } from "@/components/sentinels/sentinel-avatar";
import { AgentConversation } from "@/components/sentinels/agent-conversation";
import { GitHubWebhookControl } from "@/components/console-control/github-webhook-control";
import { AutomationEditor } from "@/components/automations/automation-editor";
import { NewAutomationDialog } from "@/components/automations/new-automation-dialog";
import { useAutomationRows } from "@/components/automations/use-automations";
import { useSentinel, useSentinels } from "@/sentinels/api";
import { orderSentinels, sentinelHref } from "@/sentinels/model";

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
  // Old `?new=1` links open the one New sentinel dialog.
  const asksToCreate = search.get("new") === "1";
  useEffect(() => { if (asksToCreate) { openNewAgent(); setSearch(previous => { const next = new URLSearchParams(previous); next.delete("new"); return next; }, { replace: true }); } }, [asksToCreate, setSearch]);
  // Old "Set up" links carried the owner in the query; the automation now lives in that Sentinel's page.
  const legacyOwner = search.get("owner");
  if (legacyOwner && sentinels.some(item => item.id === legacyOwner)) return <Navigate to={sentinelHref(legacyOwner)} replace />;
  if (loading || isLoading) return <><LoadingState label="Loading" /></>;
  if (error) return <><ErrorState error={error} onRetry={() => void refetch()} /></>;
  if (!supported) return <><EmptyState title={v("{Sentinels} are not available")} body={v("This computer is older than {Sentinels}. Update it to use them.")} /></>;
  const rows = orderSentinels(sentinels);
  const nameOf = new Map(sentinels.map(item => [item.id, item.name]));
  const hrefFor = (id: string) => `/sentinels?workflow=${encodeURIComponent(id)}`;
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
        {automations.rows.map(item => { const owner = owners.get(item.id); return <li key={item.id}><Link to={hrefFor(item.id)} className="flex items-center gap-3 px-4 py-3 text-sm outline-none ui-row-hover focus-visible:outline-ring-inset"><span className="min-w-0 flex-1 truncate">{item.name}</span><span className="hidden truncate text-xs text-muted-foreground-1 sm:block">{owner ? nameOf.get(owner) : ""}</span><span className="hidden w-40 truncate text-xs text-muted-foreground-1 md:block">{item.trigger}</span></Link></li>; })}
      </ul>
    </section>}
    {!readOnly && <GitHubWebhookControl />}
    <NewAutomationDialog open={newAutomation} onOpenChange={setNewAutomation} sentinels={sentinels} onCreated={(_owner, id) => navigate(hrefFor(id))} />
  </>;
}

/** One sentinel: its own thread, the real conversation, with a collapsible pane on the right and a Profile dialog behind the "..." menu. */
export function SentinelPage() {
  const { sentinelId = "" } = useParams();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const query = useSentinel(sentinelId);
  useBreadcrumbLabel(query.data?.name);
  usePageVariant("full");
  if (query.isLoading) return <><LoadingState label="Loading" variant="detail" /></>;
  if (query.error || !query.data) return <>{query.error instanceof Error && (query.error as { status?: number }).status !== 404 ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <NotFound section="sentinels" />}</>;
  const sentinel = query.data;
  return <AgentConversation key={sentinel.id} sentinel={sentinel} readOnly={readOnly} />;
}
