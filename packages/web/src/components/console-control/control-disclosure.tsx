import { Disclosure } from "@/components/ui/disclosure";
import type { ComponentProps, ReactNode } from "react";
import { CapyChevronDownIcon as ChevronDown } from "@/ui/icons/capy";
import { cn } from "@/lib/utils";

/** Settings use the shared animated disclosure with an accessible button trigger. */
export function ControlDisclosure({ title, children, className, ...props }: Omit<ComponentProps<typeof Disclosure>, "summary" | "title"> & { title: ReactNode }) {
  return <Disclosure {...props} className={cn("group/disclosure", className)} summary={<>
      <span className="min-w-0">{title}</span>
      <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[expanded=true]/disclosure:rotate-180 motion-reduce:transition-none" />
     </>} triggerClassName="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-1 py-2 text-sm font-medium text-foreground transition-colors hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">

    <div className="px-1 pb-2">{children}</div>
  </Disclosure>;
}
