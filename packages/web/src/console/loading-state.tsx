import { v } from "@/lib/vocabulary";
import { Skeleton } from "../ui/components/skeleton";
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

/** Host history mirrors the sidebar: a group label row, then 28px (h-7) thread rows. */
export function ChatHistorySkeleton({ rows = 5 }: { rows?: number }) {
  const widths = ["72%", "88%", "65%", "82%", "58%"];
  return <div role="status" aria-label={v("Loading {missions}")} aria-busy="true" className="space-y-0.5" data-chat-history-skeleton>
    <span className="sr-only">{v("Loading {missions}…")}</span>
    <div aria-hidden="true" className="flex h-7 items-center gap-2 px-2"><Skeleton className="size-4 shrink-0" /><Skeleton className="h-2.5 w-20" /></div>
    {Array.from({ length: rows }, (_, index) => <div key={index} className="flex h-7 items-center rounded-md px-2" aria-hidden="true"><Skeleton className="h-3" style={{ width: widths[index % widths.length] }} /></div>)}
  </div>;
}

/** Matches the transcript column (max-w-3xl) and the bottom composer card. */
export function ConversationSkeleton() {
  return <div role="status" aria-label={v("Loading {mission}")} aria-busy="true" className="flex min-h-0 flex-1 flex-col" data-conversation-skeleton>
    <span className="sr-only">{v("Loading your {mission}…")}</span>
    <div aria-hidden="true" className="mx-auto w-full max-w-3xl flex-1 space-y-8 overflow-hidden px-3 py-5 sm:px-6">
      <Skeleton className="ml-auto h-12 w-[62%] rounded-[var(--radius-card,12px)]" />
      <div className="space-y-3"><Skeleton className="h-3 w-[92%]" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-[78%]" /></div>
      <div className="space-y-3"><Skeleton className="h-3 w-[88%]" /><Skeleton className="h-3 w-[64%]" /></div>
    </div>
    <div aria-hidden="true" className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 sm:px-6" data-composer-skeleton>
      <div className="rounded-[var(--radius-card,12px)] border-[0.5px] border-[var(--card-hairline)] bg-card p-3">
        <Skeleton tone="darker" className="mb-6 h-3.5 w-40" />
        <div className="flex items-center gap-2"><Skeleton tone="darker" className="size-7 rounded-md" /><Skeleton tone="darker" className="h-7 w-20 rounded-md" /><Skeleton tone="darker" className="h-7 w-24 rounded-md" /><Skeleton tone="darker" className="ml-auto size-7 rounded-md" /></div>
      </div>
    </div>
  </div>;
}

export function ActivityIndicator({ label, waiting = false, mark = true }: { label: string; waiting?: boolean; mark?: boolean }) {
  return <div role="status" className={`console-activity flex items-center ${mark ? "gap-2.5 py-1 text-xs" : "h-7 text-sm font-medium"} text-muted-foreground`}>
    {mark && <ActivityMark waiting={waiting} />}
    <span className={waiting ? undefined : "ui-text-shimmer"}>{label}</span>
  </div>;
}
