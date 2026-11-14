import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { STORAGE_KEYS } from "@/lib/storage";
import { queueComposerPrefill } from "@/lib/composer-prefill";
import { usePersistentState } from "@/lib/use-persistent-state";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { useTeamAccess } from "@/components/team-access";
import { useProviders } from "@/components/console-control/connections-control";
import { CapyCheckIcon, CapyCloseIcon } from "@/ui/icons/capy";
import { canSeeSetupCards, deriveSetupProgress, showSetupCard, type SetupStep } from "./setup-checklist-model";
import { UPDATE_COMMAND, normalizeUpdateStatus, showUpdateCard } from "./update-status-model";

const card = "relative overflow-hidden rounded-(--radius-card) border-[0.5px] border-border-2 bg-card text-[13px] leading-[1.3] text-foreground";
const dismissButton = "absolute top-2 right-2 size-6 text-muted-foreground-2";

/** Update and setup cards above the account row. Local users and team owners only. */
export function SidebarCards() {
  const team = useTeamAccess();
  if (!canSeeSetupCards(team)) return null;
  return <div data-slot="sidebar-cards" className="flex shrink-0 flex-col gap-2 p-2 pb-0"><UpdateCard /><SetupChecklistCard /></div>;
}

function UpdateCard() {
  const { client, webFetchJson } = useBackendApi();
  const [dismissed, setDismissed] = usePersistentState<string>(STORAGE_KEYS.updateCardDismissed, "");
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.updateStatus(client.backendId),
    queryFn: async ({ signal }) => normalizeUpdateStatus(await webFetchJson<unknown>("/api/console/update-status", { signal })),
    staleTime: 60 * 60_000, retry: false, refetchOnWindowFocus: false,
  });
  const status = query.data ?? null;
  if (!showUpdateCard(status, dismissed)) return null;
  const copy = () => { void navigator.clipboard.writeText(UPDATE_COMMAND).then(() => { setCopied(true); setTimeout(() => setCopied(false), 3000); }).catch(() => undefined); };
  return (
    <section aria-label="Update available" className={`group/update ${card}`}>
      <a href={status.url} target="_blank" rel="noreferrer noopener" className="block outline-none focus-visible:outline-ring-inset focus-visible:outline-2">
        <span aria-hidden="true" className="flex h-12 items-center justify-center bg-secondary"><BrandMark compact className="size-7" /></span>
        <span className="block space-y-0.5 p-3 pb-2">
          <span className="flex items-baseline gap-2"><span className="truncate font-medium">0 {status.latest}</span><span className="shrink-0 text-xs text-primary">Update available</span></span>
          <span className="block truncate text-muted-foreground-2">You have {status.current}. See what changed.</span>
        </span>
      </a>
      <div className="px-3 pb-3">
        <Button type="button" variant="secondary" size="sm" className="w-full" onClick={copy}>{copied ? <><CapyCheckIcon aria-hidden="true" />Copied</> : `Copy update command`}</Button>
        <span role="status" className="sr-only">{copied ? `Copied ${UPDATE_COMMAND}` : ""}</span>
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Dismiss update ${status.latest}`} onClick={() => setDismissed(status.latest)} className={`${dismissButton} bg-secondary/80 opacity-0 group-hover/update:opacity-100 focus-visible:opacity-100 max-lg:opacity-100`}><CapyCloseIcon aria-hidden="true" /></Button>
    </section>
  );
}

function SetupChecklistCard() {
  const navigate = useNavigate();
  const { client, listConsoleSessions } = useBackendApi();
  const [dismissed, setDismissed] = usePersistentState<boolean>(STORAGE_KEYS.setupCardDismissed, false);
  const providers = useProviders();
  const sessions = useQuery({ queryKey: queryKeys.consoleSessions(client.backendId), queryFn: ({ signal }) => listConsoleSessions(signal), staleTime: 15_000, retry: false });
  const progress = dismissed ? null : deriveSetupProgress({
    providerConnected: providers.data?.providers.some(provider => provider.configured && provider.diagnostics.valid),
    missionStarted: sessions.data?.some(session => (session.messageCount ?? 0) > 0),
  });
  if (!showSetupCard(progress, dismissed) || !progress.next) return null;
  const next: SetupStep = progress.next;
  const act = () => {
    if (next.to) { navigate(next.to); return; }
    if (next.prompt) queueComposerPrefill(next.prompt);
    navigate("/chats");
  };
  return (
    <section aria-label="Finish setting up" className={`${card} space-y-2.5 p-3`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate font-medium">Finish setting up</h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss setup checklist" onClick={() => setDismissed(true)} className="-my-1 -mr-1.5 size-6 text-muted-foreground-2"><CapyCloseIcon aria-hidden="true" /></Button>
      </div>
      <div className="flex items-center gap-3">
        <div role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-1 min-w-0 flex-1 overflow-hidden rounded-full border-[0.5px] border-border-2 bg-secondary">
          <div className="h-full rounded-full bg-primary" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground-2">{progress.done} of {progress.total}</span>
      </div>
      <p className="flex items-center gap-2"><span aria-hidden="true" className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground-2" /><span className="min-w-0 truncate">{v(next.label)}</span></p>
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={act}>{next.id === "provider" ? "Connect a provider" : "Start a mission"}</Button>
    </section>
  );
}
