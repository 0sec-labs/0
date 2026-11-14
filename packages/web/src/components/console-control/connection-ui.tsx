import type { ReactNode } from "react";

/** Card header row: a count or title on the left and icon actions on the right. */
export function CardHeaderRow({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return <div data-slot="card-header-row" className="flex min-h-14 items-center justify-between gap-4 px-4 text-sm font-medium text-foreground"><span className="min-w-0 truncate">{title}</span><div className="flex shrink-0 items-center gap-1">{children}</div></div>;
}
