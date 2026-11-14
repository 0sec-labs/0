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

/** Host history mirrors the sidebar: a group label row, then 28px (h-7) thread rows. Delayed fade; callers skip it when rows are cached. */
export function ChatHistorySkeleton({ rows = 5 }: { rows?: number }) {
  const widths = ["72%", "88%", "65%", "82%", "58%"];
  return <SkeletonPanel label={v("Loading {missions}…")} className="space-y-0.5" data-chat-history-skeleton>
    <div className="flex h-7 items-center gap-2 px-2"><Skeleton className="size-4 shrink-0" /><Skeleton className="h-2.5 w-20" /></div>
    {Array.from({ length: rows }, (_, index) => <div key={index} className="flex h-7 items-center rounded-md px-2"><Skeleton className="h-3" style={{ width: widths[index % widths.length] }} /></div>)}
  </SkeletonPanel>;
}

/** Transcript column placeholder (max-w-3xl). The real composer renders beneath it; there is no composer skeleton. */
export function ConversationSkeleton() {
  return <SkeletonPanel label={v("Loading your {mission}…")} className="flex min-h-0 flex-1 flex-col" innerClassName="mx-auto w-full max-w-3xl flex-1 space-y-8 overflow-hidden px-3 py-5 sm:px-6" data-conversation-skeleton>
    <Skeleton className="ml-auto h-11 w-[62%]" />
    <div className="space-y-3"><Skeleton className="h-7 w-[92%]" /><Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-[78%]" /></div>
    <div className="space-y-3"><Skeleton className="h-7 w-[88%]" /><Skeleton className="h-7 w-[64%]" /></div>
  </SkeletonPanel>;
}

export function ActivityIndicator({ label, waiting = false, mark = true }: { label: string; waiting?: boolean; mark?: boolean }) {
  return <div role="status" className={`console-activity flex items-center ${mark ? "gap-2.5 py-1 text-xs" : "h-7 text-sm font-medium"} text-muted-foreground`}>
    {mark && <ActivityMark waiting={waiting} />}
    <span className={waiting ? undefined : "ui-text-shimmer"}>{label}</span>
  </div>;
}
