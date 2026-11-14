import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";

/** Let supported browsers size text directly, avoiding a forced layout per key. */
export function useComposerAutosize(textarea: RefObject<HTMLTextAreaElement | null>, text: string, visible = true): CSSProperties {
  const native = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");
  const resize = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    const node = textarea.current;
    if (native || !node) return;
    const measure = () => {
      node.style.height = "0px";
      const height = node.scrollHeight;
      node.style.height = `${Math.max(64, Math.min(height, 224))}px`;
      node.style.overflowY = height > 224 ? "auto" : "hidden";
    };
    resize.current = measure;
    measure();
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; measure(); }
    });
    observer.observe(node);
    return () => { observer.disconnect(); resize.current = undefined; };
  }, [native, textarea, visible]);
  useLayoutEffect(() => { resize.current?.(); }, [text]);
  return { ...(native ? { fieldSizing: "content" } : {}), minHeight: 64, maxHeight: 224, overflowY: native ? "auto" : undefined };
}
