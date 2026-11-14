import { useLayoutEffect, type RefObject } from "react";

export const UI_MOTION = { fast: 120, standard: 200, enter: 240, ease: "cubic-bezier(0.16, 1, 0.3, 1)" } as const;

/** Opt-in for short changing labels; no observer or animation for ordinary controls. */
export function useIntrinsicWidthMotion(ref: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element || !element.animate) return;
    let width = element.getBoundingClientRect().width;
    let animation: Animation | undefined;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const previous = width;
        animation?.cancel();
        width = element.getBoundingClientRect().width;
        if (Math.abs(width - previous) < 1) return;
        animation = element.animate([{ width: `${previous}px`, overflow: "clip" }, { width: `${width}px`, overflow: "clip" }], { duration: UI_MOTION.standard, easing: UI_MOTION.ease });
      });
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); animation?.cancel(); };
  }, [ref, enabled]);
}
