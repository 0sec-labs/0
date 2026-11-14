import type { ComponentProps } from "react"

import { cn } from "../lib/utils.js"

/** Keyboard shortcut hint: a small tinted key cap. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn("inline-flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-(--radius-kbd) bg-secondary px-1 font-sans text-xs text-muted-foreground-1", className)}
      {...props}
    />
  )
}
