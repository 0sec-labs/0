import { X } from "lucide-react";
import { STORAGE_KEYS } from "@/lib/storage";
import { usePersistentState } from "@/lib/use-persistent-state";
import { LATEST_RELEASE } from "@/lib/releases";
import { showWhatsNewCard } from "@/lib/whats-new";
import { useOpenWhatsNew } from "@/lib/use-open-whats-new";
import { Button } from "@/ui/components/button";
import { ReleaseHero } from "@/components/whats-new-dialog";

/** Sidebar entry for the newest release. Opening or dismissing it marks the version as seen. */
export function SidebarWhatsNewCard() {
  const open = useOpenWhatsNew();
  const [seen, setSeen] = usePersistentState<string>(STORAGE_KEYS.whatsNewSeen, "");
  if (!showWhatsNewCard(LATEST_RELEASE.version, seen)) return null;
  return (
    <section aria-label="What's new" className="group/whats-new relative overflow-hidden rounded-(--radius-card) border-[0.5px] border-border-2 bg-card text-[13px] leading-[1.3] text-foreground">
      <button type="button" onClick={() => { setSeen(LATEST_RELEASE.version); open(); }} className="flex w-full items-center gap-3 p-2 pr-9 text-left outline-none focus-visible:outline-ring-inset">
        <ReleaseHero release={LATEST_RELEASE} className="size-10 shrink-0 rounded-md" />
        <span className="min-w-0 space-y-0.5">
          <span className="block truncate font-medium">Version {LATEST_RELEASE.version}</span>
          <span className="block truncate text-muted-foreground-2">{LATEST_RELEASE.summary}</span>
        </span>
      </button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Dismiss what's new in ${LATEST_RELEASE.version}`} onClick={() => setSeen(LATEST_RELEASE.version)} className="absolute top-2 right-2 size-6 text-muted-foreground-2"><X strokeWidth={1.5} aria-hidden="true" /></Button>
    </section>
  );
}
