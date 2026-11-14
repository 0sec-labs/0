import { ChatHistorySkeleton, ConversationSkeleton } from "@/console/loading-state";

/**
 * The real app frame (sidebar chrome + header) painted while the workspace session and engine handshake resolve.
 * The frame itself has no skeleton blocks; only data-bound regions get delayed skeleton panels.
 */
export function ShellFrame() {
  const conversation = /^\/(b\/[^/]+\/)?chats\/[^/]+/.test(window.location.pathname);
  return <div aria-busy="true" className="flex h-dvh min-h-0 w-full overflow-hidden bg-background" data-shell-frame>
    <aside className="hidden w-64 shrink-0 flex-col bg-chrome p-3 md:flex"><div className="mt-10"><ChatHistorySkeleton rows={6} /></div></aside>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header aria-hidden="true" className="h-12 shrink-0" />
      {conversation ? <ConversationSkeleton /> : null}
    </main>
  </div>;
}
