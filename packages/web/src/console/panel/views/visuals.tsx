import { useContext, useMemo, useState } from "react";
import { Locate } from "lucide-react";
import { CapyChevronRightIcon as ChevronRight } from "@/ui/icons/capy";
import { cn } from "@/lib/utils";
import { VisualBlock } from "../../visual-block";
import { visualsFromSnapshot } from "../../visuals";
import { HarnessActionsContext } from "./tools";
import type { PanelViewComponent } from "../types";

/** Every visual in the mission, newest last as in the transcript; each row expands to the full renderer. */
export const VisualsView: PanelViewComponent = ({ snapshot }) => {
  const { appendPrompt } = useContext(HarnessActionsContext);
  const visuals = useMemo(() => (snapshot ? visualsFromSnapshot(snapshot) : []), [snapshot]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!snapshot)
    return (
      <p role="status" className="p-4 text-center text-xs text-muted-foreground-2">
        Loading chat…
      </p>
    );
  if (!visuals.length)
    return (
      <p className="px-4 py-10 text-center text-xs text-muted-foreground">
        No visuals yet; ask the agent to diagram an attack path or chart.
      </p>
    );
  const reveal = (id: string) =>
    document
      .querySelector(`[data-slot="visual"][data-visual-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  return (
    <section aria-label="Visuals from this chat" className="min-h-0 h-full space-y-2 overflow-y-auto scroll-fade-y p-2">
      {visuals.map((visual) => {
        const expanded = open[visual.id] ?? false;
        return (
          <article
            key={visual.id}
            aria-label={visual.title}
            className="rounded-lg border-[0.5px] border-border-1 bg-card"
          >
            <header className="flex min-h-8 items-center gap-1 px-2">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen((previous) => ({ ...previous, [visual.id]: !expanded }))}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground-2 transition-transform motion-reduce:transition-none",
                    expanded && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{visual.title}</span>
                <span className="shrink-0 rounded-full bg-secondary px-1.5 text-2xs text-muted-foreground">
                  {visual.kind}
                </span>
              </button>
              <button
                type="button"
                title="Show in chat"
                aria-label={`Show ${visual.title} in chat`}
                onClick={() => reveal(visual.id)}
                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Locate aria-hidden="true" className="size-3" />
              </button>
            </header>
            {!expanded && <p className="line-clamp-2 px-2 pb-2 text-xs text-muted-foreground-2">{visual.summary}</p>}
            {expanded && (
              <div className="border-t-[0.5px] border-border-1 p-2">
                <VisualBlock visual={visual} onReference={appendPrompt} />
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
};
