import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SidebarDensity } from "@/lib/sidebar-rows";
import { SidebarLabel } from "@/ui/components/sidebar";

/** Shared row chrome: 52px (32px compact), 8px padding, 6px radius, white-alpha hover and the active token. */
export const sidebarRowClasses = (density: SidebarDensity) => cn(
  "group/row relative flex w-full min-w-0 shrink-0 items-center gap-2.5 rounded-md px-2 text-left outline-none select-none transition-colors duration-100 hover:bg-secondary focus-visible:outline-ring-inset data-[active]:bg-secondary aria-[current=page]:bg-secondary",
  density === "compact" ? "h-8" : "h-13",
);

/** Line 1 title (75% foreground, 100% on hover or when active) with the age on the right. */
export function RowTitleLine({ title, trailing, className }: { title: ReactNode; trailing?: ReactNode; className?: string }) {
  return <span className="flex min-w-0 items-center gap-2">
    <SidebarLabel className={cn("text-sm leading-5 font-[450] tracking-[-0.02em] text-foreground/75 transition-colors duration-100 group-hover/row:text-foreground group-data-[active]/row:text-foreground group-aria-[current=page]/row:text-foreground", className)}>{title}</SidebarLabel>
    {trailing}
  </span>;
}

export const RowAge = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn("shrink-0 text-xs leading-5 tabular-nums text-muted-foreground-1", className)}>{children}</span>;

/** Line 2: 12px muted, one line, fading at the right edge. */
export const RowSubline = ({ children, className }: { children: ReactNode; className?: string }) => <SidebarLabel className={cn("block flex-none text-xs leading-4 text-muted-foreground-1", className)}>{children}</SidebarLabel>;
