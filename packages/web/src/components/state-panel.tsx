import type { ReactNode } from "react";
import { Skeleton, SkeletonPanel } from "../ui/components/skeleton";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";

/**
 * Delayed placeholder for data-bound lists and card grids (cached content stays mounted, so callers skip it then).
 * Settings forms and detail pages render nothing while loading, so `detail` and `form` are intentionally blank.
 */
export function LoadingState({ label, variant = "list", rows = 3, className }: { label: string; variant?: "list" | "cards" | "detail" | "form"; rows?: number; className?: string }) {
  if (variant === "detail" || variant === "form") return null;
  const status = /^loading/i.test(label) ? label : `Loading ${label.toLocaleLowerCase()}…`;
  return <SkeletonPanel data-page-skeleton label={status} aria-label={status} className={cn("w-full min-w-0", className)}>
    {variant === "cards" ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: rows }, (_, index) => <div key={index} className="flex min-h-44 flex-col gap-4 rounded-[var(--radius-panel)] border-[0.5px] border-[var(--card-hairline)] bg-card p-5"><Skeleton className="size-5" /><Skeleton className="h-7 w-3/5" /><div className="space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div><Skeleton className="mt-auto h-3 w-1/3" /></div>)}</div>
      : <div className="space-y-1">{Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>}
  </SkeletonPanel>;
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
