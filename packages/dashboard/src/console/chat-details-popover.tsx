import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { ContextRing } from "@/components/ui/context-ring";
import { Button } from "@/components/ui/button";

/** A nonmodal header control, never a dock panel or a replacement transcript. */
export function ChatDetailsPopover({ open, onOpenChange, children, contextPercent }: { contextPercent?: number; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = popup.current;
    if (!element) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      element.style.left = `${Math.max(8, Math.min(rect.right - 304, innerWidth - 312))}px`;
      element.style.maxHeight = `${Math.max(120, Math.min(560, rect.top - 16))}px`;
      element.style.top = `${Math.max(8, rect.top - element.getBoundingClientRect().height - 8)}px`;

    };
    if (open) { element.showPopover(); place(); } else if (element.matches(":popover-open")) element.hidePopover();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  return <>
    <Button ref={trigger} variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Chat usage and tools" title={contextPercent === undefined ? "Chat usage and tools" : `${contextPercent}% context used · Chat usage and tools`} aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)}><ContextRing percent={contextPercent} /></Button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-label="Chat information" onToggle={event => onOpenChange(event.newState === "open")} className="fixed m-0 w-[304px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-2xl border border-border bg-card text-card-foreground shadow-xl">{open && children}</div>
  </>;
}
