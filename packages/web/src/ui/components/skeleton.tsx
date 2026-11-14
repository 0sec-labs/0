import type { ComponentProps } from "react";
import { cn } from "../lib/utils.js";

/** A neutral placeholder. Its parent supplies one accessible loading announcement. `tone="darker"` suits surfaces already tinted like the default skeleton. */
export function Skeleton({ className, tone, ...props }: ComponentProps<"div"> & { tone?: "default" | "darker" }) {
  return <div aria-hidden="true" {...props} data-slot="skeleton" data-tone={tone === "darker" ? "darker" : undefined} className={cn("relative overflow-hidden rounded-md bg-card-hover bg-(image:--gradient-skeleton) bg-[length:200%_100%] animate-[skeleton-pulse_2.4s_ease-in-out_infinite] motion-reduce:animate-none data-[tone=darker]:bg-secondary data-[tone=darker]:bg-(image:--gradient-skeleton-darker)", className)} />;
}
