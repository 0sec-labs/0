import type { ComponentProps } from "react";
import { cn } from "../lib/utils.js";

/** A neutral placeholder. Its parent supplies one accessible loading announcement. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden="true" {...props} data-slot="skeleton" className={cn("ui-skeleton relative overflow-hidden rounded-md", className)} />;
}
