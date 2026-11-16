import { v } from "@/lib/vocabulary";
import { Skeleton, SkeletonPanel } from "../ui/components/skeleton";
import { Loader } from "../ui/components/loader";

/** Compatibility footprint for the shared nine-square activity mark. */
export function ActivityMark({ className = "", compact = false, waiting = false }: { className?: string; compact?: boolean; waiting?: boolean }) {
  return <span aria-hidden="true" data-waiting={waiting || undefined} className={`relative inline-flex flex-none items-center justify-center align-middle text-inherit ${compact ? "h-4 w-3.5 [&>svg]:block [&>svg]:size-3.5" : "h-4 w-[18px] [&>svg]:block [&>svg]:size-4"} ${className}`}>
    <Loader active={!waiting} aria-hidden="true" />
  </span>;
}

/** Compatibility for shared consumers: the old dots now use the same activity mark. */
export function LoadingDots({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  return <ActivityMark className={className} compact={compact} />;
}

/**
 * Host history mirrors the sidebar: a group label row, then 28px (h-7) thread rows. Delayed fade; callers skip it when rows
 * are cached. Rows are short, uneven title-length strokes at a quiet tint, so the list reads as a hint and not as blocks.
 */
export function ChatHistorySkeleton({ rows = 5 }: { rows?: number }) {
  const widths = ["58%", "74%", "46%", "68%", "52%", "80%"];
  return <SkeletonPanel label={v("Loading {missions}…")} className="space-y-0.5" data-chat-history-skeleton>
    <div className="flex h-7 items-center px-2"><Skeleton className="h-2.5 w-16 bg-secondary/60" /></div>
    {Array.from({ length: rows }, (_, index) => <div key={index} className="flex h-7 items-center rounded-md px-2"><Skeleton className="h-3 rounded-md bg-secondary/60" style={{ width: widths[index % widths.length] }} /></div>)}
  </SkeletonPanel>;
}

/** A user bubble stand-in: narrower than the column and right-aligned, like the real message. */
const ThreadUser = ({ width }: { width: string }) => <Skeleton className="ml-auto h-9 max-w-[45%] rounded-md bg-secondary/60" style={{ width }} />;
/** Assistant text stand-in: stacked h-3.5 strokes of natural uneven widths, the last one short. */
const ThreadAnswer = ({ lines }: { lines: string[] }) => <div className="flex flex-col gap-2.5">{lines.map((width, index) => <Skeleton key={index} className="h-3.5 rounded-md bg-secondary/60" style={{ width }} />)}</div>;

/**
 * A disabled composer card docked where the real one will be (same column, padding, radius and rail height), so nothing
 * moves when the live composer replaces it. It is static: only the transcript above it pulses.
 */
export function ComposerPlaceholder() {
  return <div aria-hidden="true" data-composer-placeholder className="shrink-0 p-3 sm:px-6">
    <div className="mx-auto max-w-[712px]">
      <div className="flex flex-col rounded-[var(--radius-card,8px)] bg-card p-3 opacity-70 shadow-[var(--shadow-composer)]">
        <div className="min-h-[52px] px-1 py-1 text-[15px] leading-6 text-muted-foreground-2 select-none">{v("Ask 0 to work on this {mission}…")}</div>
        <div className="flex h-8 items-center gap-1.5"><Skeleton className="size-5 bg-secondary/60" /><Skeleton className="h-3 w-16 bg-secondary/60" /><Skeleton className="h-3 w-24 bg-secondary/60" /><Skeleton className="ml-auto size-8 rounded-full bg-secondary/60" /></div>
      </div>
      <div className="min-h-8 pt-1" />
    </div>
  </div>;
}

/**
 * Opening an existing mission: a thread-shaped hint (a right-aligned user bubble, then a few uneven lines of assistant
 * text, twice) in the same column as the real transcript, fading out at the top, above a disabled composer in the
 * composer's exact slot. No header strip. The placeholder pulses once as a group and stays invisible for 250 ms.
 */
export function ConversationSkeleton() {
  return <div className="flex min-h-0 flex-1 flex-col" data-conversation-skeleton>
    <SkeletonPanel label={v("Loading your {mission}…")} className="min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_72px)]" innerClassName="mx-auto flex h-full w-full max-w-[660px] flex-col justify-end gap-10 overflow-hidden px-3 pb-6 pt-5 sm:px-6">
      <ThreadUser width="38%" />
      <ThreadAnswer lines={["92%", "100%", "64%"]} />
      <ThreadUser width="28%" />
      <ThreadAnswer lines={["86%", "97%", "42%"]} />
    </SkeletonPanel>
    <ComposerPlaceholder />
  </div>;
}

export function ActivityIndicator({ label, waiting = false, mark = true }: { label: string; waiting?: boolean; mark?: boolean }) {
  return <div role="status" className={`console-activity flex items-center ${mark ? "gap-2.5 py-1 text-xs" : "h-7 text-sm font-medium"} text-muted-foreground`}>
    {mark && <ActivityMark waiting={waiting} />}
    <span className={waiting ? undefined : "ui-text-shimmer"}>{label}</span>
  </div>;
}
