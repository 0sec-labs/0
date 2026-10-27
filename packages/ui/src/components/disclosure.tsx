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
  return <section {...props} data-expanded={expanded || undefined} className={cn("ui-disclosure",className)}>
    {actions ? <div className="group/disclosure-heading flex min-w-0 items-center">
      <button type="button" id={`${id}-trigger`} aria-expanded={expanded} aria-controls={`${id}-content`} className={cn("ui-disclosure-trigger min-w-0 flex-1",triggerClassName)} onClick={()=>{const next=!expanded;if(open===undefined)setLocalOpen(next);onOpenChange?.(next);}}>{summary}</button>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/disclosure-heading:opacity-100 group-focus-within/disclosure-heading:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">{actions}</div>
    </div> : <button type="button" id={`${id}-trigger`} aria-expanded={expanded} aria-controls={`${id}-content`} className={cn("ui-disclosure-trigger",triggerClassName)} onClick={()=>{const next=!expanded;if(open===undefined)setLocalOpen(next);onOpenChange?.(next);}}>{summary}</button>}
    <div id={`${id}-content`} aria-labelledby={`${id}-trigger`} aria-hidden={!expanded} inert={!expanded} className="ui-disclosure-reveal">
      <div className="ui-disclosure-inner"><div className={contentClassName}>{children}</div></div>
    </div>
  </section>;
}
