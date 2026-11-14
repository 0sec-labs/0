import * as React from "react"

import { cn } from "../lib/utils.js"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-none rounded-[var(--radius-control,8px)] border border-[var(--field-border)] bg-[var(--field-surface)] px-3 py-3 text-base transition-[color,box-shadow,border-color] duration-150 motion-reduce:transition-none outline-none placeholder:text-muted-foreground focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
