import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils.js";

/** One flat placeholder bar. It never animates itself: the enclosing `SkeletonPanel` pulses the whole group once. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden="true" {...props} data-slot="skeleton" className={cn("rounded-md bg-secondary", className)} />;
}

/**
 * Wrapper for skeletons of data-bound regions (lists, transcript, models). It mounts at once but stays invisible
 * for 250ms, then fades in, so fetches that finish quickly never show a skeleton. Never use it for composers,
 * menus or settings forms.
 */
export function SkeletonPanel({ label, className, innerClassName, children, ...props }: Omit<ComponentProps<"div">, "children"> & { label: string; innerClassName?: string; children: ReactNode }) {
  return <div data-slot="skeleton-panel" role="status" aria-busy="true" {...props} className={cn("opacity-100 transition-opacity delay-[250ms] duration-200 ease-[var(--ui-ease-out)] starting:opacity-0 motion-reduce:transition-none", className)}>
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className={cn("animate-skeleton-pulse motion-reduce:animate-none", innerClassName)}>{children}</div>
  </div>;
}
