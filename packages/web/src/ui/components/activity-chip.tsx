import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils.js";

/** Shared quiet icon treatment for recorded activity, sources and live tools. */
export function ActivityIcon({ children, className }: { children: ReactNode; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-inset ring-foreground/10 [&_svg]:size-3", className)}>{children}</span>;
}
const chip = "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export function ActivityChip({ icon, children, className, ...props }: ComponentProps<"button"> & { icon: ReactNode }) {
  return <button type="button" {...props} className={cn(chip, className)}><ActivityIcon>{icon}</ActivityIcon><span className="truncate">{children}</span></button>;
}
export function SourceChip({ icon, children, className, ...props }: ComponentProps<"a"> & { icon: ReactNode }) {
  return <a {...props} className={cn(chip, "gap-1.5 bg-muted px-2.5 hover:bg-muted/70 [&_svg]:size-3 [&_svg]:shrink-0", className)}>{icon}<span className="truncate">{children}</span></a>;
}

/** Bounded overlapping activity marks; callers supply stable keys for arriving tools. */
export function ActivityStack({ items, label, active = false }: { items: readonly { id: string; icon: ReactNode; label: string }[]; label: string; active?: boolean }) {
  return <span className="ui-activity-stack" aria-label={label} data-active={active || undefined}>
    {items.slice(-3).map(item => <span key={item.id} title={item.label} className="ui-activity-stack-item"><ActivityIcon>{item.icon}</ActivityIcon></span>)}
    {items.length > 3 && <span className="ui-activity-stack-count" aria-hidden="true">+{items.length - 3}</span>}
  </span>;
}
