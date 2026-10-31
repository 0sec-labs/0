import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "../lib/utils.js";

/** Truncated titles reveal themselves slowly on row hover or keyboard focus. */
export function OverflowText({ text, className }: { text: string; className?: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  useLayoutEffect(() => {
    let mounted = true;
    const measure = () => {
      if (mounted && viewport.current && content.current) setDistance(Math.max(0, Math.ceil(content.current.scrollWidth - viewport.current.clientWidth)));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (viewport.current) observer?.observe(viewport.current);
    if (content.current) observer?.observe(content.current);
    void document.fonts?.ready.then(measure);
    return () => { mounted = false; observer?.disconnect(); };
  }, [text]);
  return <span ref={viewport} data-overflowing={distance > 1 || undefined} className={cn("ui-overflow-text", className)} style={{ "--overflow-distance": `${-distance}px`, "--overflow-duration": `${Math.max(4, distance / 28 * 2 + 1)}s` } as CSSProperties}>
    <span ref={content} className="ui-overflow-text-content">{text}</span>
  </span>;
}
