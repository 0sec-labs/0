import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 28px bordered tile that frames a provider or service logo, as in Capy's connection and plugin rows. */
export function LogoTile({ children, className, ...props }: ComponentProps<"span">) {
  return <span aria-hidden="true" data-slot="logo-tile" className={cn("grid size-7 shrink-0 place-items-center rounded-(--radius-button) border-[0.5px] border-border-2 bg-secondary text-foreground", className)} {...props}>{children}</span>;
}

/** Plain status word with a subtle pill: "Connected", "Needs connection", "Off". */
export function StatusPill({ tone = "muted", children }: { tone?: "ok" | "warn" | "muted"; children: ReactNode }) {
  return <span data-slot="status-pill" data-tone={tone} className={cn("inline-flex h-6 shrink-0 items-center rounded-full border-[0.5px] border-border-2 bg-card px-2 text-xs", tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-muted-foreground-1")}>{children}</span>;
}

/** Card header row: a count or title on the left and icon actions on the right. */
export function CardHeaderRow({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return <div data-slot="card-header-row" className="flex min-h-14 items-center justify-between gap-4 px-4 text-sm font-medium text-foreground"><span className="min-w-0 truncate">{title}</span><div className="flex shrink-0 items-center gap-1">{children}</div></div>;
}
