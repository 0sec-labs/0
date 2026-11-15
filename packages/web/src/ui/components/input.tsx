import * as React from "react"

import { cn } from "../lib/utils.js"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[var(--ui-control-height,var(--control-height,32px))] w-full min-w-0 rounded-md border-[0.5px] border-border-2 bg-card px-3 py-1 text-base transition-[color,box-shadow,border-color] duration-[var(--ui-duration-fast,100ms)] motion-reduce:transition-none outline-none focus-visible:outline-ring-inset file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
