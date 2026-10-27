import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "../lib/utils.js"
import { useIntrinsicWidthMotion } from "../motion.js"

/** One shared secondary control surface; outline remains a compatibility alias. */
const SECONDARY = "border-[length:var(--ui-control-border-width,1px)] border-[color:var(--ui-control-border-color,var(--border))] bg-[var(--ui-control-surface,var(--secondary))] text-[color:var(--ui-button-secondary-foreground,var(--foreground))] hover:bg-[var(--ui-control-surface-hover,var(--muted))] aria-expanded:bg-[var(--ui-control-surface-hover,var(--muted))]"

const buttonVariants = cva(
  "group/button cursor-pointer disabled:cursor-default aria-disabled:cursor-default inline-flex shrink-0 items-center justify-center rounded-[var(--ui-button-radius,var(--radius-control,8px))] border border-transparent text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-[var(--ui-duration-fast,120ms)] ease-out motion-reduce:transition-none outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--ui-button-background,var(--foreground))] text-[color:var(--ui-button-foreground,var(--background))] hover:opacity-90",
        outline: SECONDARY,
        secondary: SECONDARY,
        row: "bg-transparent text-inherit hover:bg-transparent hover:text-foreground active:scale-100",
        ghost:
          "hover:bg-[var(--surface-hover)] hover:text-foreground aria-expanded:bg-[var(--surface-selected)] aria-expanded:text-foreground",
        accent: "border-[var(--primary-border)] bg-primary text-primary-foreground hover:bg-[var(--primary-hover)]",
        success:
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/16 dark:bg-emerald-500/18 dark:text-emerald-200 dark:hover:bg-emerald-500/24",
        warning:
          "border-amber-500/20 bg-amber-500/10 text-amber-700 hover:bg-amber-500/16 dark:bg-amber-500/18 dark:text-amber-200 dark:hover:bg-amber-500/24",
        danger:
          "border-destructive/20 bg-destructive/10 text-destructive hover:bg-destructive/16 dark:bg-destructive/20 dark:text-destructive",
        destructive:
          "bg-destructive-background text-destructive-foreground hover:bg-destructive-background/92 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-[var(--ui-control-height,var(--control-height))] gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[var(--ui-control-height-sm,var(--control-height-sm))] gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-[var(--ui-control-height-lg,var(--control-height-lg))] gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-[var(--ui-control-height,var(--control-height))]",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[var(--ui-control-height-sm,var(--control-height-sm))]",
        "icon-lg": "size-[var(--ui-control-height-lg,var(--control-height-lg))]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  animateWidth = false,
  ref,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Animate an intrinsic label/content change; ordinary controls remain observer-free. */
    animateWidth?: boolean
  }) {
  const Comp = asChild ? Slot : "button"
  // A changed element kind must rebind the observer to the replacement node.
  const motionRef = React.useMemo<React.RefObject<HTMLElement | null>>(() => ({ current: null }), [asChild])
  const composedRef = React.useCallback((node: HTMLButtonElement | null) => {
    motionRef.current = node
    const cleanup = typeof ref === "function" ? ref(node) : undefined
    if (ref && typeof ref !== "function") ref.current = node
    if (!node) return
    return () => {
      motionRef.current = null
      if (typeof cleanup === "function") cleanup()
      else if (typeof ref === "function") ref(null)
      else if (ref) ref.current = null
    }
  }, [ref, motionRef])
  useIntrinsicWidthMotion(motionRef, animateWidth)

  return (
    <Comp
      ref={composedRef}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
