import { useState, type ReactNode } from "react";
import { CapyChevronRightIcon as ChevronRight } from "@/ui/icons/capy";
import { Disclosure } from "@/components/ui/disclosure";

export const CARD_CLASS = "rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card";

/** Title, one muted helper line, optional right-side actions, then the section body. */
export function FormSection({ title, description, actions, id, children, ...props }: { title: string; description?: string; actions?: ReactNode; id?: string; children: ReactNode; "data-workflow-section"?: string }) {
  return <section id={id} aria-label={title} className="scroll-mt-16 space-y-3" {...props}>
    <div className="flex min-h-7 items-center justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-medium">{title}</h2>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div>{actions}</div>
    {children}
  </section>;
}

/** Collapsed-by-default section below Usage. Children mount on first open so heavy panels do not fetch until asked for. */
export function CollapsibleSection({ title, description, id, defaultOpen = false, children, ...props }: { title: string; description?: string; id: string; defaultOpen?: boolean; children: ReactNode; "data-workflow-section"?: string }) {
  const [opened, setOpened] = useState(defaultOpen);
  return <Disclosure id={id} {...props} defaultOpen={defaultOpen} onOpenChange={open => { if (open) setOpened(true); }} className={`group/collapsible scroll-mt-16 ${CARD_CLASS}`}
    triggerClassName="flex min-h-11 w-full items-center gap-2 px-4 py-2" contentClassName="px-4 pb-4"
    summary={<><ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[expanded]/collapsible:rotate-90" /><span className="min-w-0"><span className="block text-sm font-medium">{title}</span>{description && <span className="block text-xs text-muted-foreground">{description}</span>}</span></>}>
    {opened ? children : null}
  </Disclosure>;
}
