import type { ComponentProps } from "react";
import { cn } from "../lib/utils.js";

/** Divided surface for a group of settings rows. It has no padding of its own: rows own their `p-4`. */
export function SettingsCard({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="settings-card" className={cn("-mx-4 flex min-w-0 flex-col divide-y-[0.5px] divide-border-1 overflow-clip rounded-[var(--radius-card,8px)] border-[0.5px] border-[var(--card-hairline)] bg-card", className)} {...props} />;
}

/** Label and description on the left, right-aligned control on the right. */
export function SettingsCardRow({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="settings-row" className={cn("group/row flex items-center justify-between gap-6 p-4", className)} {...props} />;
}
