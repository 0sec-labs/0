import "./loading-state.css";

/** A quiet activity cue. Its caller supplies the accessible status text. */
export function LoadingDots({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`console-loading-dots ${className}`}><span /><span /><span /></span>;
}

/** Layout placeholders are shown only while a selected session is loading. */
export function ConversationSkeleton() {
  return <div role="status" aria-label="Loading conversation" className="flex min-h-0 flex-1 flex-col">
    <span className="sr-only">Loading your conversation…</span>
    <div aria-hidden="true" className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-6 py-8">
      <div className="ml-auto h-14 w-2/3 rounded-2xl console-skeleton" />
      <div className="space-y-3"><div className="h-3 w-28 rounded console-skeleton" /><div className="h-3 w-full rounded console-skeleton" /><div className="h-3 w-5/6 rounded console-skeleton" /><div className="h-3 w-3/5 rounded console-skeleton" /></div>
    </div>
    <div aria-hidden="true" className="p-6"><div className="console-skeleton mx-auto h-14 max-w-3xl rounded-3xl" /></div>
  </div>;
}

export function ActivityIndicator({ label, waiting = false }: { label: string; waiting?: boolean }) {
  return <div role="status" className="console-activity flex items-center gap-2.5 py-1 text-xs text-muted-foreground">
    {waiting ? <span aria-hidden="true" className="size-2 rounded-full bg-amber-500" /> : <LoadingDots />}
    <span className={waiting ? undefined : "console-working-label"}>{label}</span>
  </div>;
}
