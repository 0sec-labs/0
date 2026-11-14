import { memo, useMemo } from "react";
import { MessageSquareQuote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Visualization, validateViz } from "./viz";
import { visualReference, visualRenderSpec, type VisualItem } from "./visuals";

/** One visual with its title, caption and an "ask about this" action; shared by the transcript and the Visuals view. */
export const VisualBlock = memo(function VisualBlock({ visual, onReference }: {
  visual: VisualItem;
  /** Adds text to the composer draft; absent when the reader cannot write. */
  onReference?: (text: string) => void;
}) {
  const parsed = useMemo(() => validateViz(visual.kind, visualRenderSpec(visual)), [visual]);
  return <figure data-slot="visual" data-visual-id={visual.id} className="m-0 flex min-w-0 flex-col gap-1.5">
    {parsed.ok ? <Visualization spec={parsed.spec} /> : <div role="note" className="rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card p-3 text-xs">
      <p className="font-medium text-foreground">{visual.title}</p>
      <p className="mt-1 text-muted-foreground wrap-anywhere">{visual.summary}</p>
      <p className="mt-1 text-muted-foreground-2">This visualization can't be shown here: {parsed.reason}.</p>
    </div>}
    {(visual.caption || onReference) && <figcaption className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground-2">
      {visual.caption && <span className="min-w-0 flex-1 wrap-anywhere">{visual.caption}</span>}
      {onReference && <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-xs" onClick={() => onReference(visualReference(visual))}><MessageSquareQuote aria-hidden="true" className="size-3" />Ask about this</Button>}
    </figcaption>}
  </figure>;
});
