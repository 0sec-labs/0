import * as React from "react"

import { cn } from "../lib/utils.js"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-none rounded-md border-[0.5px] border-border-2 bg-card px-3 py-3 text-base transition-[color,box-shadow,border-color] duration-150 motion-reduce:transition-none outline-none placeholder:text-muted-foreground focus-visible:border-border-3 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
