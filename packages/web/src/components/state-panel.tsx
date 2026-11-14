import type { ReactNode } from "react";
import { Skeleton } from "../ui/components/skeleton";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";

/** Placeholder geometry mirrors the arriving content; cached content stays mounted. */
export function LoadingState({ label, variant = "list", rows = 3, className }: { label: string; variant?: "list" | "cards" | "detail" | "form"; rows?: number; className?: string }) {
  const status = /^loading/i.test(label) ? label : `Loading ${label.toLocaleLowerCase()}…`;
  return <div data-slot="page-skeleton" role="status" aria-label={status} aria-busy="true" className={cn("w-full min-w-0", className)}>
    <span className="sr-only">{status}</span>
    {variant === "cards" ? <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: rows }, (_, index) => <div key={index} className="flex min-h-44 flex-col gap-4 rounded-[var(--radius-panel)] border-[0.5px] border-[var(--card-hairline)] bg-card p-5"><Skeleton className="size-5 rounded-md" /><Skeleton className="h-3.5 w-3/5" /><div className="space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div><Skeleton className="mt-auto h-3 w-1/3" /></div>)}</div>
      : variant === "detail" ? <div aria-hidden="true" className="min-h-64 space-y-6 py-2"><Skeleton className="h-6 w-2/5" /><div className="space-y-3"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-11/12" /><Skeleton className="h-3 w-3/4" /></div><Skeleton className="h-24 w-full rounded-[var(--radius-panel)]" /><div className="space-y-3"><Skeleton className="h-3 w-5/6" /><Skeleton className="h-3 w-2/3" /></div></div>
      : variant === "form" ? <div aria-hidden="true" className="space-y-6 py-2">{Array.from({ length: rows }, (_, index) => <div key={index} className="space-y-3"><Skeleton className="h-3 w-28" /><Skeleton className="h-9 w-full rounded-[var(--radius-control)]" /></div>)}</div>
      : <div aria-hidden="true" className="divide-y-[0.5px] divide-[var(--card-hairline)] overflow-hidden rounded-[var(--radius-panel)] border-[0.5px] border-[var(--card-hairline)] bg-card">{Array.from({ length: rows }, (_, index) => <div key={index} className="flex min-h-14 items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-3.5 w-2/5" /><Skeleton className="h-3 w-3/4" /></div><Skeleton className="hidden h-7 w-16 rounded-md sm:block" /></div>)}</div>}
  </div>;
}

/**
 * The one empty state. `page` is the default centred block, `fill` takes the remaining height of a panel
 * (list/detail panes), and `inline` is a single muted line inside a card.
 */
export function EmptyState({ title, body, action, illustration, icon, variant = "page" }: { title: ReactNode; body?: ReactNode; action?: ReactNode; illustration?: ReactNode; icon?: ReactNode; variant?: "page" | "fill" | "inline" }) {
  if (variant === "inline") return <p className="py-6 text-center text-sm text-muted-foreground">{title}</p>;
  if (variant === "fill") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        {illustration}
        {icon ? <span aria-hidden="true" className="text-muted-foreground-2 [&_svg]:size-6">{icon}</span> : null}
        <p className="text-sm font-medium text-foreground">{title}</p>
        {body ? <p className="max-w-xs text-xs text-muted-foreground-1">{body}</p> : null}
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex min-h-[10rem] flex-col items-center justify-center gap-3 py-8 text-center">
      {illustration}
      {icon ? <span aria-hidden="true" className="text-muted-foreground-2 [&_svg]:size-6">{icon}</span> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
      </div>
      {action ?? null}
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    <Card className="border border-destructive/25">
      <CardContent className="flex min-h-[10rem] flex-col items-center justify-center gap-4 text-center">
        <AlertTriangle className="size-8 text-destructive" />
        <div>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </div>
      </CardContent>
    </Card>
  );
}
