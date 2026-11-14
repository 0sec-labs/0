import type { ComponentProps, ReactNode } from "react";
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
    <header className={cn("flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 space-y-1.5">
        <div>
          <h1 className="break-words font-sans text-2xl font-medium tracking-tight text-foreground">{title}</h1>
          {summary ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{summary}</p> : null}
        </div>
      </div>
      {(actions || illustration) ? <div className={cn("min-w-0 shrink-0 items-center gap-3 sm:max-w-[55%] sm:justify-end", actions ? "flex" : "hidden sm:flex")}>{actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}{illustration}</div> : null}
    </header>
  );
}

/**
 * Capy's page shell: one centred column. `readable` (3xl) is the default, `wide` is 5xl, `full` removes the cap
 * for table/board pages. Vertical rhythm and gutters live here so no page invents its own.
 */
export function PageContent({ width = "readable", className, ...props }: ComponentProps<"div"> & { width?: "readable" | "wide" | "full" }) {
  return <div {...props} data-page-width={width} className={cn("ui-surface-enter mx-auto flex w-full min-w-0 flex-col gap-10 px-6 pt-6 pb-10 md:pt-16", width === "readable" ? "max-w-3xl" : width === "wide" ? "max-w-5xl" : undefined, className)} />;
}
