import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/components/toast";
import { useBackendApi } from "@/api";
import { queryKeys } from "@/queries";
import { STORAGE_KEYS } from "@/lib/storage";
import { requestMissionStart } from "@/lib/mission-start";
import { usePersistentState } from "@/lib/use-persistent-state";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { useTeamAccess } from "@/components/team-access";
import { useProviders } from "@/components/console-control/connections-control";
import { CapyCheckIcon, CapyCloseIcon } from "@/ui/icons/capy";
import { canSeeSetupCards, deriveSetupProgress, firstThreadStarted, showSetupCard, type SetupStep } from "./setup-checklist-model";
import { providerUnusable } from "./provider-health";
import { SidebarWhatsNewCard } from "@/components/sidebar-whats-new-card";
import {
  PENDING_UPDATE_KEY, PENDING_UPDATE_MAX_MS, currentVersionOf, normalizeUpdateStatus, parsePendingUpdate, showUpdateCard, updateCardView,
  updateCommandFor, updateFinished, type PendingUpdate, type UpdateCardUi,
} from "./update-status-model";

const card = "relative overflow-hidden rounded-(--radius-card) border-[0.5px] border-border-2 bg-card text-[13px] leading-[1.3] text-foreground";
const dismissButton = "absolute top-2 right-2 size-6 text-muted-foreground-2";

/** Update and setup cards above the account row. Local users and team owners only. */
export function SidebarCards() {
  const team = useTeamAccess();
  const owner = canSeeSetupCards(team);
  return <div data-slot="sidebar-cards" className="flex shrink-0 flex-col gap-2 p-2 pb-0 empty:hidden">{owner && <UpdateRestartWatcher />}{owner && <UpdateCard />}<SidebarWhatsNewCard />{owner && <SetupChecklistCard />}</div>;
}

function UpdateCard() {
  const { client, webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = usePersistentState<string>(STORAGE_KEYS.updateCardDismissed, "");
  const [copied, setCopied] = useState(false);
  const [ui, setUi] = useState<UpdateCardUi>({ confirmThreads: null, working: null });
  const queryKey = queryKeys.updateStatus(client.backendId);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => normalizeUpdateStatus(await webFetchJson<unknown>("/api/console/update-status", { signal })),
    staleTime: 60_000, retry: false, refetchOnWindowFocus: true,
  });
  const status = query.data ?? null;
  if (!showUpdateCard(status, dismissed)) return null;
  const view = updateCardView(status, ui);
  const command = status.canApply ? "" : updateCommandFor(status.install.kind);
  const copy = () => { void navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 3000); }).catch(() => undefined); };
  const apply = async (confirm: boolean) => {
    setUi({ confirmThreads: null, working: "updating" });
    try {
      const answer = await webFetchJson<{ version?: string; supervised?: boolean }>("/api/console/update/apply", { method: "POST", body: JSON.stringify({ confirm }) });
      const pending: PendingUpdate = { version: answer.version ?? status.latest, startedAt: Date.now(), supervised: answer.supervised === true };
      try { localStorage.setItem(PENDING_UPDATE_KEY, JSON.stringify(pending)); } catch { /* the watcher below still runs for this page */ }
      window.dispatchEvent(new Event(PENDING_UPDATE_EVENT));
      setUi({ confirmThreads: null, working: "restarting" });
    } catch (error) {
      const body = error as { status?: number; code?: string; message?: string };
      if (body.code === "threads_running") {
        const threads = Number(/^(\d+)/.exec(body.message ?? "")?.[1] ?? status.threadsRunning);
        setUi({ confirmThreads: threads > 0 ? threads : 1, working: null });
      } else {
        setUi({ confirmThreads: null, working: null, failure: body.message || "The update did not start." });
        void queryClient.invalidateQueries({ queryKey });
      }
    }
  };
  const action = view.action;
  return (
    <section aria-label="Update available" data-update-phase={ui.working ?? status.phase} className={`group/update ${card}`}>
      <span aria-hidden="true" className="flex h-12 items-center justify-center bg-secondary"><BrandMark compact className="size-7" /></span>
      <span className="block space-y-0.5 p-3 pb-2">
        <span className="block truncate font-medium text-primary">{view.title}</span>
        <span className="block text-muted-foreground-2">{view.detail}. <a href={status.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:outline-ring-inset">What's new</a></span>
        {action.kind === "copy" && action.note && <span className="block text-muted-foreground-2">{action.note}</span>}
      </span>
      <div className="space-y-1.5 px-3 pb-3">
        {action.kind === "copy" && <>
          <Button type="button" variant="secondary" size="sm" className="w-full" onClick={copy}>{copied ? <><CapyCheckIcon aria-hidden="true" />Copied</> : action.label}</Button>
          <span role="status" className="sr-only">{copied ? `Copied ${command}` : ""}</span>
        </>}
        {action.kind === "apply" && <Button type="button" size="sm" className="w-full" onClick={() => void apply(false)}>{action.label}</Button>}
        {action.kind === "busy" && <Button type="button" size="sm" className="w-full" disabled aria-busy="true">{action.label}</Button>}
        {action.kind === "confirm" && <>
          <span role="alert" className="block text-muted-foreground-2">{action.message}</span>
          <Button type="button" variant="secondary" size="sm" className="w-full" onClick={() => setUi({ confirmThreads: null, working: null })}>{action.wait}</Button>
          <Button type="button" size="sm" className="w-full" onClick={() => void apply(true)}>{action.anyway}</Button>
        </>}
        {view.failure && <span role="alert" className="block text-destructive">{view.failure}</span>}
      </div>
      {action.kind !== "busy" && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Dismiss update ${status.latest}`} onClick={() => setDismissed(status.latest)} className={`${dismissButton} bg-secondary/80 opacity-0 group-hover/update:opacity-100 focus-visible:opacity-100 max-lg:opacity-100`}><CapyCloseIcon aria-hidden="true" /></Button>}
    </section>
  );
}

const PENDING_UPDATE_EVENT = "0-update-pending";

/**
 * Follows an update that was started from this page. The server goes away for a moment (the existing reconnect
 * handling covers the gap), comes back as the new version, and then this reports it. Survives a page reload.
 */
function UpdateRestartWatcher() {
  const { client, webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingUpdate | null>(() => readPending());
  useEffect(() => {
    const sync = () => setPending(readPending());
    window.addEventListener(PENDING_UPDATE_EVENT, sync);
    return () => window.removeEventListener(PENDING_UPDATE_EVENT, sync);
  }, []);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const clear = () => { try { localStorage.removeItem(PENDING_UPDATE_KEY); } catch { /* ignore */ } if (live) setPending(null); };
    const poll = async () => {
      if (!live) return;
      if (Date.now() - pending.startedAt > PENDING_UPDATE_MAX_MS) {
        toast({ id: "update-result", kind: "error", title: "0 did not come back after updating", description: pending.supervised ? "Check that your service manager restarts it, then reload this page." : "Reload this page, or start 0 again.", durationMs: 0 });
        clear();
        return;
      }
      let current: string | null = null;
      try { current = currentVersionOf(await webFetchJson<unknown>("/api/console/update-status", { signal: AbortSignal.timeout(4000) })); } catch { /* still restarting */ }
      if (!live) return;
      if (updateFinished(pending, current)) {
        toast({ id: "update-result", kind: "success", title: `Updated to ${current}` });
        clear();
        void queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus(client.backendId) });
        return;
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    let timer = setTimeout(() => void poll(), 1500);
    return () => { live = false; clearTimeout(timer); };
  }, [pending, webFetchJson, queryClient, client.backendId]);
  return null;
}

function readPending(): PendingUpdate | null {
  try { return parsePendingUpdate(localStorage.getItem(PENDING_UPDATE_KEY), Date.now()); } catch { return null; }
}

function SetupChecklistCard() {
  const navigate = useNavigate();
  const { client, listConsoleSessions, listSavedConsoleSessions } = useBackendApi();
  const [dismissed, setDismissed] = usePersistentState<boolean>(STORAGE_KEYS.setupCardDismissed, false);
  const providers = useProviders();
  const sessions = useQuery({ queryKey: queryKeys.consoleSessions(client.backendId), queryFn: ({ signal }) => listConsoleSessions(signal), staleTime: 15_000, retry: false });
  const saved = useQuery({ queryKey: queryKeys.consoleSaved(), queryFn: ({ signal }) => listSavedConsoleSessions(signal), staleTime: 15_000, retry: false });
  const { pathname } = useLocation();
  const missionId = /^\/chats\/([^/]+)$/.exec(pathname)?.[1];
  // Home is the new-mission screen: the bare route, or a mission that has no messages yet.
  // A mission missing from the list (just created) is still Home; only one known to have messages is not, so the card never blinks while the list catches up.
  const onHome = pathname === "/" || pathname === "/chats" || (missionId !== undefined && sessions.data?.some(session => session.id === missionId && (session.messageCount ?? 0) > 0) !== true);
  const progress = dismissed || !onHome ? null : deriveSetupProgress({
    providerConnected: providers.data?.providers.some(provider => provider.configured && provider.diagnostics.valid && !providerUnusable(provider)),
    missionStarted: firstThreadStarted(sessions.data, saved.data),
  });
  if (!showSetupCard(progress, dismissed) || !progress.next) return null;
  const next: SetupStep = progress.next;
  const act = () => {
    if (next.to) { navigate(next.to); return; }
    if (next.prompt) requestMissionStart(next.prompt);
    navigate("/chats");
  };
  return (
    <section aria-label="Finish setting up" className={`${card} space-y-2 p-3`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate font-medium">Finish setting up</h2>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground-2">{progress.done} of {progress.total}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss setup checklist" tooltip="Dismiss setup checklist" onClick={() => setDismissed(true)} className="-my-1 -mr-1.5 size-6 text-muted-foreground-2"><CapyCloseIcon aria-hidden="true" /></Button>
      </div>
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={act}>{next.action}</Button>
    </section>
  );
}
