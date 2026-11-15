import { useEffect, useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Accessibility, Bug, ChevronLeft, ChevronRight, Cloud, Gauge, Laptop, ListChecks, Palette, Plug, Puzzle, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, Wrench, KeyRound, ArrowUpRight, type LucideProps } from "lucide-react";
import { useBackendApi } from "@/api";
import { queryKeys } from "@/queries";
import { STORAGE_KEYS } from "@/lib/storage";
import { usePersistentState } from "@/lib/use-persistent-state";
import { LATEST_RELEASE, RELEASES, RELEASES_URL, type LucideIconName, type Release } from "@/lib/releases";
import { onOpenWhatsNew, releaseIndex, shouldAutoOpenWhatsNew } from "@/lib/whats-new";
import { useProviders } from "@/components/console-control/connections-control";
import { useTeamAccess } from "@/components/team-access";
import { providerUnusable } from "@/console/provider-health";
import { canSeeSetupCards, deriveSetupProgress, showSetupCard } from "@/console/setup-checklist-model";
import { Button } from "@/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/components/dialog";

export const RELEASE_ICONS: Record<LucideIconName, ComponentType<LucideProps>> = { Palette, Laptop, Puzzle, ShieldCheck, KeyRound, Gauge, RefreshCw, Accessibility, Wrench, Plug, Cloud, ListChecks, ShieldAlert, Bug };

/** Hero image on a soft tile; releases without a picture get a neutral tile. */
export function ReleaseHero({ release, className = "" }: { release: Release; className?: string }) {
  return (
    <div aria-hidden="true" className={`flex items-center justify-center overflow-hidden bg-secondary ${className}`}>
      {release.image ? <img src={release.image} alt="" decoding="async" className="size-full object-cover object-top-left" /> : <Sparkles strokeWidth={1.5} className="size-6 text-muted-foreground-2" />}
    </div>
  );
}

export function WhatsNewDialog({ open, onOpenChange, version, onVersionChange }: { open: boolean; onOpenChange: (open: boolean) => void; version: string; onVersionChange: (version: string) => void }) {
  const index = releaseIndex(version);
  const release = RELEASES[index]!;
  const older = RELEASES[index + 1];
  const newer = RELEASES[index - 1];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[480px]">
        <ReleaseHero release={release} className="aspect-[16/9] shrink-0" />
        <div className="space-y-5 p-6">
          <div className="space-y-1.5">
            <DialogTitle className="text-lg leading-tight">{release.title}</DialogTitle>
            <p className="text-xs tabular-nums text-muted-foreground-2">Version {release.version} · {release.date}</p>
            <DialogDescription>{release.summary}</DialogDescription>
          </div>
          <ul className="space-y-4">
            {release.highlights.map(item => {
              const Icon = RELEASE_ICONS[item.icon] ?? Sparkles;
              return (
                <li key={item.title} className="flex gap-3">
                  <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground-1"><Icon strokeWidth={1.5} className="size-4" /></span>
                  <div className="min-w-0 space-y-0.5"><p className="text-sm font-medium">{item.title}</p><p className="text-sm text-muted-foreground">{item.text}</p></div>
                </li>
              );
            })}
          </ul>
          <Button type="button" className="w-full" autoFocus onClick={() => onOpenChange(false)}>Got it</Button>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
            <Button type="button" variant="ghost" size="sm" className="justify-self-start" disabled={!older} onClick={() => older && onVersionChange(older.version)} aria-label={older ? `Previous version ${older.version}` : "No previous version"}>
              <ChevronLeft strokeWidth={1.5} aria-hidden="true" /><span className="max-sm:sr-only">Previous</span>
            </Button>
            <Button type="button" variant="ghost" size="sm" render={<a href={RELEASES_URL} target="_blank" rel="noreferrer noopener" />}>All releases<ArrowUpRight strokeWidth={1.5} aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="sm" className="justify-self-end" disabled={!newer} onClick={() => newer && onVersionChange(newer.version)} aria-label={newer ? `Next version ${newer.version}` : "Already on the latest version"}>
              <span>Next</span><ChevronRight strokeWidth={1.5} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Owns the dialog: auto-opens once per version (never over the first-run setup card) and reopens from the palette, menu and sidebar card. */
export function WhatsNewHost() {
  const team = useTeamAccess();
  const { client, listConsoleSessions } = useBackendApi();
  const providers = useProviders();
  const sessions = useQuery({ queryKey: queryKeys.consoleSessions(client.backendId), queryFn: ({ signal }) => listConsoleSessions(signal), staleTime: 15_000, retry: false });
  const [setupDismissed] = usePersistentState<boolean>(STORAGE_KEYS.setupCardDismissed, false);
  const [seen, setSeen] = usePersistentState<string>(STORAGE_KEYS.whatsNewSeen, "");
  const [autoOpened, setAutoOpened] = usePersistentState<string>(STORAGE_KEYS.whatsNewAutoOpened, "");
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(LATEST_RELEASE.version);

  const progress = deriveSetupProgress({
    providerConnected: providers.data?.providers.some(provider => provider.configured && provider.diagnostics.valid && !providerUnusable(provider)),
    missionStarted: sessions.data?.some(session => (session.messageCount ?? 0) > 0),
  });
  const known = !canSeeSetupCards(team) || progress !== null;
  const setupCardVisible = canSeeSetupCards(team) && showSetupCard(progress, setupDismissed);
  const auto = known && shouldAutoOpenWhatsNew({ latest: LATEST_RELEASE.version, seen, autoOpened, setupCardVisible });
  useEffect(() => {
    if (!auto) return;
    setAutoOpened(LATEST_RELEASE.version);
    setVersion(LATEST_RELEASE.version);
    setOpen(true);
  }, [auto, setAutoOpened]);
  useEffect(() => onOpenWhatsNew(next => { setVersion(next); setOpen(true); setSeen(LATEST_RELEASE.version); }), [setSeen]);

  return <WhatsNewDialog open={open} version={version} onVersionChange={setVersion} onOpenChange={next => { setOpen(next); if (!next) setSeen(LATEST_RELEASE.version); }} />;
}
