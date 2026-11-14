import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

/** Scroll container whose bottom edge fades out only while more content lies below. */
export function ScrollFade({ className, onScroll, ...props }: ComponentPropsWithoutRef<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setMore(node.scrollHeight - node.scrollTop - node.clientHeight > 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  return <div
    {...props}
    ref={ref}
    data-fade={more || undefined}
    onScroll={(event) => { const node = event.currentTarget; setMore(node.scrollHeight - node.scrollTop - node.clientHeight > 2); onScroll?.(event); }}
    className={cn("overflow-auto data-[fade]:[-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%_-_28px),transparent)] data-[fade]:[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_28px),transparent)]", className)}
  />;
}
