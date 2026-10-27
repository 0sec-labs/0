import type { ComponentProps } from "react";
import { cn } from "../lib/utils.js";

export type LoaderProps = ComponentProps<"svg"> & {
  /** Set false while waiting; only recorded active work should animate. */
  active?: boolean;
};

/** Shared nine-square activity mark. Import @0/ui/styles/loader.css once. */
export function Loader({ className, active = true, ...props }: LoaderProps) {
  return <svg role="status" aria-label={active ? "Loading" : "Waiting"} viewBox="0 0 18 18" fill="currentColor" focusable="false" data-slot="loader" data-active={active || undefined} className={cn("size-4 shrink-0", className)} {...props}>
    {[0, 1, 2].flatMap(row => [0, 1, 2].map(column => <rect key={`${row}-${column}`} className="ui-loader-cell" x={column * 6 + 1} y={row * 6 + 1} width="4" height="4" rx=".5" style={{ animationDelay: `${(row + column) * 100}ms` }} />))}
  </svg>;
}
