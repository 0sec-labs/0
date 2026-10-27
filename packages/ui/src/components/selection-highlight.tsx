import { useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils.js";
import { prefersReducedMotion, UI_MOTION } from "../motion.js";

/** One moving selection surface; text and rows never translate or change order. */
export function SelectionHighlight({ activeKey, revision, className }: { activeKey: string; revision?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current, host = element?.parentElement;
    if (!element || !host) return;
    const target = host.querySelector<HTMLElement>('[data-ui-selected="true"]');
    if (!target) { element.style.opacity = "0"; previous.current = null; return; }
    let animation: Animation | undefined;
    const place = (animate: boolean) => {
      const parent = host.getBoundingClientRect(), rect = target.getBoundingClientRect();
      const next = { left: rect.left - parent.left, top: rect.top - parent.top, width: rect.width, height: rect.height };
      const old = previous.current;
      Object.assign(element.style, { left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px`, opacity: "1" });
      animation?.cancel();
      if (animate && old && !prefersReducedMotion(element) && element.animate && old.width > 0 && next.width > 0 && (old.top !== next.top || old.left !== next.left)) {
        animation = element.animate([{ transformOrigin: "top left", transform: `translate(${old.left-next.left}px,${old.top-next.top}px) scale(${old.width/next.width},${old.height/next.height})` }, { transformOrigin: "top left", transform: "none" }], { duration: UI_MOTION.standard, easing: UI_MOTION.ease });
      }
      previous.current = next;
    };
    place(true);
    const resize = new ResizeObserver(() => place(false));
    resize.observe(host); resize.observe(target);
    return () => { resize.disconnect(); animation?.cancel(); };
  }, [activeKey, revision]);
  return <span ref={ref} aria-hidden="true" className={cn("pointer-events-none absolute z-0 rounded-[var(--radius-control)] bg-muted", className)} style={{ opacity: 0 }} />;
}
