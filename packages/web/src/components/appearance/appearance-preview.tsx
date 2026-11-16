import { BackdropStill, type BackdropKind } from "@/ui/backdrops";
import { cn } from "@/ui/lib/utils";

/**
 * A small New thread screen built from the real tokens: the sidebar strip, the backdrop (the same frame and opacity the live
 * screen uses), a heading and the composer. It inherits the page's colour theme, accent, mode and text size, so it changes the
 * moment any option does. It is decoration for sighted users, so it is hidden from assistive tech.
 */
export function AppearancePreview({ background, className }: { background: BackdropKind; className?: string }) {
  return <div aria-hidden="true" inert data-appearance-preview className={cn("pointer-events-none flex h-48 select-none overflow-hidden rounded-md border-[0.5px] border-border-2 bg-background text-foreground", className)}>
    <div className="flex w-[22%] shrink-0 flex-col gap-1 border-r-[0.5px] border-border-1 bg-panel p-2 text-2xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium"><span className="size-3.5 rounded-sm bg-primary" />Zero</div>
      <div className="truncate rounded-sm bg-secondary px-1.5 py-1 font-medium">Threads</div>
      <div className="truncate px-1.5 py-1 text-muted-foreground-1">Agents</div>
      <div className="truncate px-1.5 py-1 text-muted-foreground-1">Computers</div>
      <div className="truncate px-1.5 py-1 text-muted-foreground-1">Memory</div>
    </div>
    <div className="relative flex min-w-0 flex-1 flex-col items-center justify-end gap-3 p-4">
      <BackdropStill kind={background} variant="screen" />
      <p className="relative text-sm font-medium">What should we work on?</p>
      <div className="relative flex w-full max-w-sm items-center justify-between rounded-md border-[0.5px] border-border-2 bg-card px-3 py-2 text-xs shadow-composer">
        <span className="text-muted-foreground-2">Ask anything</span>
        <span className="grid size-5 place-items-center rounded-md bg-primary text-primary-foreground"><span className="size-1.5 rounded-[1px] bg-primary-foreground" /></span>
      </div>
    </div>
  </div>;
}
