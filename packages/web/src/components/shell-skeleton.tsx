import { Skeleton } from "@/ui/components/skeleton";
import { ChatHistorySkeleton, ConversationSkeleton } from "@/console/loading-state";

/** Neutral app frame (sidebar + conversation) shown while the workspace session and engine handshake resolve. */
export function ShellSkeleton() {
  return <div role="status" aria-label="Opening workspace" aria-busy="true" className="flex h-dvh min-h-0 w-full overflow-hidden bg-background" data-shell-skeleton>
    <aside aria-hidden="true" className="hidden w-64 shrink-0 flex-col gap-3 bg-chrome p-3 md:flex">
      <Skeleton className="h-7 w-28" />
      <Skeleton className="h-8 w-full" />
      <ChatHistorySkeleton rows={6} />
    </aside>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col"><ConversationSkeleton /></main>
  </div>;
}
