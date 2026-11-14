import { ExternalLink } from "lucide-react";
import { CapyIssueDashedIcon, CapyPullRequestIcon } from "@/ui/icons/capy";
import { useOptionalPanelViews } from "./panel/panel-view-host";
import type { TurnArtifact } from "./transcript-actions";

const open =
  "ml-auto inline-flex h-6 flex-none items-center gap-1 rounded-[var(--radius-inner,4px)] px-1.5 text-xs text-muted-foreground-1 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/** Compact card for something this turn produced: a saved finding or a recorded pull request. */
export function ArtifactCard({ artifact, sessionId }: { artifact: TurnArtifact; sessionId: string }) {
  const panel = useOptionalPanelViews();
  const Icon = artifact.kind === "pull-request" ? CapyPullRequestIcon : CapyIssueDashedIcon;
  const canOpenPanel = artifact.kind === "finding" && panel?.sessionId === sessionId;
  return (
    <div
      data-slot="artifact-card"
      data-artifact-kind={artifact.kind}
      className="flex min-h-9 min-w-0 items-center gap-2 rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card px-2.5 py-1 text-sm"
    >
      <Icon aria-hidden="true" className="size-4 flex-none text-muted-foreground-1" />
      <span className="min-w-0 truncate font-medium text-foreground" title={artifact.title}>
        {artifact.title}
      </span>
      <span className="flex-none rounded-full bg-secondary px-1.5 py-px text-2xs text-muted-foreground-1">{artifact.status}</span>
      {artifact.url ? (
        <a href={artifact.url} target="_blank" rel="noopener noreferrer" className={open}>
          Open
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : (
        canOpenPanel && (
          <button type="button" className={open} onClick={() => panel?.openView("findings")}>
            Open
          </button>
        )
      )}
    </div>
  );
}
