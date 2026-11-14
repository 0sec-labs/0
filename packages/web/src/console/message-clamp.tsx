import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const CLAMP_HEIGHT = 320;
/** Avoid collapsing for a few pixels of overflow. */
const CLAMP_SLACK = 48;

/** Pure clamp decision: never while the message may still grow. */
export function shouldClamp(contentHeight: number, disabled: boolean, limit = CLAMP_HEIGHT): boolean {
  return !disabled && contentHeight > limit + CLAMP_SLACK;
}

// In-memory only; keyed by message id.
const expandedMessages = new Map<string, boolean>();

/** Collapse very long finished assistant messages behind a fade and a Show more control. */
export function MessageClamp({ id, disabled = false, children }: { id: string; disabled?: boolean; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [expanded, setExpanded] = useState(() => expandedMessages.get(id) ?? false);
  const region = useId();
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    setHeight(node.scrollHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.scrollHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setExpanded(expandedMessages.get(id) ?? false); }, [id]);
  const clampable = shouldClamp(height, disabled);
  const collapsed = clampable && !expanded;
  const toggle = () => { const next = !expanded; expandedMessages.set(id, next); setExpanded(next); };
  return <div data-clamped={collapsed || undefined} className="min-w-0">
    <div id={region} style={collapsed ? { maxHeight: CLAMP_HEIGHT } : undefined} className={cn("min-w-0", collapsed && "overflow-hidden [mask-image:linear-gradient(to_bottom,#000_calc(100%-56px),transparent)]")}>
      <div ref={inner} className="min-w-0">{children}</div>
    </div>
    {clampable && <button type="button" aria-expanded={expanded} aria-controls={region} onClick={toggle} className="mt-1 inline-flex min-h-6 items-center gap-1 rounded-[var(--radius-inner,4px)] px-1 text-xs text-muted-foreground-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      {expanded ? "Show less" : "Show more"}<ChevronDown aria-hidden="true" className={cn("size-3 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
    </button>}
  </div>;
}
