import { useId, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../lib/utils.js";

/** Mounted disclosure content keeps its state; inert blocks hidden keyboard controls. */
export function Disclosure({ summary, actions, children, open, defaultOpen = false, onOpenChange, triggerClassName, contentClassName, className, ...props }: Omit<ComponentPropsWithoutRef<"section">, "children" | "onChange"> & {
  summary: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const [localOpen,setLocalOpen] = useState(defaultOpen);
  const expanded = open ?? localOpen;
  const id=useId();
  return <section {...props} data-expanded={expanded || undefined} className={className}>
    {actions ? <div className="group/disclosure-heading flex min-w-0 items-center">
      <button type="button" id={`${id}-trigger`} aria-expanded={expanded} aria-controls={`${id}-content`} className={cn("min-w-0 flex-1 cursor-pointer rounded-[var(--radius-control,8px)] text-left outline-none focus-visible:outline-ring-inset",triggerClassName)} onClick={()=>{const next=!expanded;if(open===undefined)setLocalOpen(next);onOpenChange?.(next);}}>{summary}</button>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/disclosure-heading:opacity-100 group-focus-within/disclosure-heading:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">{actions}</div>
    </div> : <button type="button" id={`${id}-trigger`} aria-expanded={expanded} aria-controls={`${id}-content`} className={cn("cursor-pointer rounded-[var(--radius-control,8px)] text-left outline-none focus-visible:outline-ring-inset",triggerClassName)} onClick={()=>{const next=!expanded;if(open===undefined)setLocalOpen(next);onOpenChange?.(next);}}>{summary}</button>}
    <div id={`${id}-content`} aria-labelledby={`${id}-trigger`} aria-hidden={!expanded} inert={!expanded} data-expanded={expanded || undefined} className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(.16,1,.3,1)] data-[expanded]:grid-rows-[1fr] data-[expanded]:opacity-100 motion-reduce:transition-none">
      <div className="min-h-0 overflow-hidden"><div className={contentClassName}>{children}</div></div>
    </div>
  </section>;
}
