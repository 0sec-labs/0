import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "../lib/utils.js"

const badgeVariants = cva(
  "group/badge inline-flex h-[var(--ui-badge-height,1.25rem)] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[var(--ui-badge-radius,9999px)] border-[length:var(--ui-badge-border-width,1px)] border-[color:var(--ui-badge-border-color,transparent)] px-2 py-0.5 text-xs font-medium shadow-[var(--ui-badge-shadow,0_0_#0000)] whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-[var(--ui-duration-fast,120ms)] motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      size: { default: "", control: "h-[var(--ui-control-height,2.5rem)] gap-1.5 rounded-[var(--ui-button-radius,0.625rem)] px-3 text-sm [&>svg]:size-4!" },
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        neutral:
          "border-border/40 bg-muted text-foreground [a]:hover:bg-secondary/80",
        accent:
          "bg-primary/12 text-primary-text dark:bg-primary/18",
        success:
          "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/18 dark:text-emerald-200",
        warning:
          "bg-amber-500/12 text-amber-700 dark:bg-amber-500/18 dark:text-amber-200",
        danger:
          "bg-destructive/12 text-destructive dark:bg-destructive/18 dark:text-destructive",
        info:
          "bg-sky-500/12 text-sky-700 dark:bg-sky-500/18 dark:text-sky-200",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border/40 bg-background text-foreground [a]:hover:bg-[var(--surface-hover)] [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-[var(--surface-hover)] hover:text-foreground",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
