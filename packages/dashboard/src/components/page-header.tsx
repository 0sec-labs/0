import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  summary,
  actions,
  className,
  illustration,
}: {
  eyebrow?: string;
  title: string;
  summary?: string;
  actions?: ReactNode;
  className?: string;
  illustration?: ReactNode;
}) {
  return (
    <header className={cn("flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between", className)}>
      <div className="space-y-1.5">
        <div>
          <h1 className="font-sans text-2xl font-medium tracking-tight text-foreground">{title}</h1>
          {summary ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{summary}</p> : null}
        </div>
      </div>
      {(actions || illustration) ? <div className={cn("shrink-0 items-center justify-between gap-5", actions ? "flex" : "hidden sm:flex")}>{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}{illustration}</div> : null}
    </header>
  );
}
