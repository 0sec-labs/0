import { Disclosure } from "@/components/ui/disclosure";
import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Settings use the shared animated disclosure with an accessible button trigger. */
export function ControlDisclosure({ title, children, className, ...props }: Omit<ComponentProps<typeof Disclosure>, "summary" | "title"> & { title: ReactNode }) {
  return <Disclosure {...props} className={cn("group/disclosure overflow-hidden rounded-[var(--radius-menu,12px)] bg-muted/20", className)} summary={<>
      <span className="min-w-0">{title}</span>
      <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[expanded=true]/disclosure:rotate-180 motion-reduce:transition-none" />
     </>} triggerClassName="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radius-menu,12px)] bg-muted/40 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">

    <div className="border-t border-border/30 px-4 pb-4 pt-1">{children}</div>
  </Disclosure>;
}
