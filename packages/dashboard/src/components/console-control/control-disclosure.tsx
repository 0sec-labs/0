import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Native keyboard and disclosure semantics, with the same row treatment as settings controls. */
export function ControlDisclosure({ title, children, className, ...props }: Omit<ComponentProps<"details">, "title"> & { title: ReactNode }) {
  return <details {...props} className={cn("group/disclosure overflow-hidden rounded-xl bg-muted/20", className)}>
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl bg-muted/40 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
      <span className="min-w-0">{title}</span>
      <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/disclosure:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="border-t border-border/30 px-4 pb-4 pt-1">{children}</div>
  </details>;
}
