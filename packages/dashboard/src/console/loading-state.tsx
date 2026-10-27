import { Skeleton } from "@0/ui/components/skeleton";
import { Loader } from "@0/ui/components/loader";
import "./loading-state.css";

/** Compatibility footprint for the shared nine-square activity mark. */
export function ActivityMark({ className = "", compact = false, waiting = false }: { className?: string; compact?: boolean; waiting?: boolean }) {
  return <span aria-hidden="true" data-waiting={waiting || undefined} className={`console-activity-mark ${compact ? "console-activity-mark-compact" : ""} ${className}`}>
    <Loader active={!waiting} aria-hidden="true" />
  </span>;
}

/** Compatibility for shared consumers: the old dots now use the same activity mark. */
export function LoadingDots({ className = "" }: { className?: string }) {
  return <ActivityMark className={className} />;
}

/** Host history retains row geometry instead of shifting around a loading label. */
export function ChatHistorySkeleton({ rows = 5 }: { rows?: number }) {
  const widths = ["72%", "88%", "65%", "82%", "58%"];
  return <div role="status" aria-label="Loading chats" aria-busy="true" className="space-y-0.5" data-chat-history-skeleton>
    <span className="sr-only">Loading chats…</span>
    {Array.from({ length: rows }, (_, index) => <div key={index} className="flex h-[38px] items-center px-3" aria-hidden="true"><Skeleton className="h-3.5" style={{ width: widths[index % widths.length] }} /></div>)}
  </div>;
}

/** Matches the transcript column and attached workspace/composer footprint. */
export function ConversationSkeleton() {
  return <div role="status" aria-label="Loading conversation" aria-busy="true" className="flex min-h-0 flex-1 flex-col" data-conversation-skeleton>
    <span className="sr-only">Loading your conversation…</span>
    <div aria-hidden="true" className="mx-auto w-full max-w-3xl flex-1 space-y-8 overflow-hidden px-3 py-5 sm:px-6">
      <Skeleton className="ml-auto h-[72px] w-[86%] rounded-[var(--radius-panel)]" />
      <div className="space-y-3"><Skeleton className="h-3 w-[92%]" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-[78%]" /></div>
      <div className="space-y-3"><Skeleton className="h-3 w-[88%]" /><Skeleton className="h-3 w-[64%]" /></div>
    </div>
    <div aria-hidden="true" className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 sm:px-6" data-composer-skeleton>
      <Skeleton className="mx-3 mb-[-10px] h-9 rounded-t-[var(--radius-composer)] rounded-b-none" />
      <div className="relative h-[114px] rounded-[var(--radius-composer)] bg-muted/50 p-4">
        <Skeleton className="h-3 w-36" />
        <div className="absolute inset-x-4 bottom-3 flex items-center gap-3"><Skeleton className="size-5 rounded-full" /><Skeleton className="h-3 w-16" /><Skeleton className="ml-auto h-3 w-28" /><Skeleton className="size-7 rounded-[var(--radius-control)]" /></div>
      </div>
    </div>
  </div>;
}

export function ActivityIndicator({ label, waiting = false }: { label: string; waiting?: boolean }) {
  return <div role="status" className="console-activity flex items-center gap-2.5 py-1 text-xs text-muted-foreground">
    <ActivityMark waiting={waiting} />
    <span className={waiting ? undefined : "console-working-label"}>{label}</span>
  </div>;
}
