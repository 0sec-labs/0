import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils.js"
import { useRender } from "@base-ui/react/use-render"
import { useIntrinsicWidthMotion } from "../motion.js"
import { Loader } from "./loader.js"

/* Variant recipes. Colour arrives through --intent-* variables; the fallback after each comma is the neutral value. */
const SOLID = "border-[color:var(--intent-border-solid,var(--intent-border,var(--border-2)))] bg-[color:var(--intent-bg,var(--button))] text-[color:var(--intent-text-on-bg,var(--foreground))] [--focus-ring:var(--intent-text-on-bg,var(--ring))] shadow-[inset_0_1px_var(--intent-highlight,var(--highlight-top)),var(--sh-plate)] hover:bg-[color:var(--intent-bg-solid-hover,var(--button-hover))] aria-expanded:bg-[color:var(--intent-bg-solid-hover,var(--button-hover))] active:shadow-none"
const SOFT = "bg-[color:var(--intent-bg-soft,var(--secondary))] text-[color:var(--intent-text,var(--foreground))] hover:bg-[color:var(--intent-bg-soft-hover,var(--secondary-hover))] aria-expanded:bg-[color:var(--intent-bg-soft-hover,var(--secondary-hover))]"
const GHOST = "bg-transparent text-[color:var(--intent-text,var(--muted-foreground-1))] hover:bg-[color:var(--intent-bg-hover,var(--secondary))] hover:text-[color:var(--intent-text-hover,var(--foreground))] data-[popup-open]:bg-[color:var(--intent-bg-hover,var(--secondary))] data-[popup-open]:text-[color:var(--intent-text-hover,var(--foreground))] aria-expanded:bg-[color:var(--intent-bg-hover,var(--secondary))] aria-expanded:text-[color:var(--intent-text-hover,var(--foreground))]"
const OUTLINE = "border-[color:var(--intent-border,var(--border-2))] bg-[var(--button)] text-[color:var(--intent-text,var(--foreground))] hover:bg-[color:var(--intent-bg-hover,var(--secondary))] aria-expanded:bg-[color:var(--intent-bg-hover,var(--secondary))]"
const LINK = "text-[color:var(--text-link)] underline-offset-2 hover:underline"
const BARE = "bg-transparent text-[color:var(--intent-text,var(--muted-foreground-1))] hover:text-[color:var(--intent-text-hover,var(--foreground))] data-[popup-open]:text-[color:var(--intent-text-hover,var(--foreground))]"
const INVERSE = "bg-[color:var(--intent-bg,var(--inverse))] text-[color:var(--intent-text-on-bg,var(--inverse-text))] [--focus-ring:var(--intent-text-on-bg,var(--inverse-text))] active:brightness-95"
const SEGMENTED = `${GHOST} data-[selected]:bg-[color:var(--intent-bg,var(--card))] data-[selected]:shadow-card`

const INTENT = {
  accent: "ui-intent-accent",
  danger: "ui-intent-danger",
  warning: "ui-intent-warning",
  success: "ui-intent-success",
} as const

/**
 * Public variants map onto Capy's variant x intent matrix:
 * default/accent = solid accent, secondary = solid neutral, outline = outline neutral, ghost = ghost neutral,
 * success/warning/danger = soft + intent, destructive = solid danger, link = link, row = unstyled inherit.
 * solid/soft/bare/inverse/segmented are exposed for direct use.
 */
const buttonVariants = cva(
  "group/button relative inline-flex w-fit shrink-0 cursor-pointer items-center justify-center rounded-[var(--ui-button-radius,var(--radius-button))] border-[0.5px] border-transparent font-medium text-nowrap whitespace-nowrap [text-box-trim:trim-both] transition-colors duration-100 motion-reduce:transition-none outline-none select-none focus-visible:outline-ring-inset active:brightness-97 pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:size-full pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[''] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-55 aria-invalid:border-destructive data-[selected]:bg-secondary data-[selected]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-base)",
  {
    variants: {
      variant: {
        default: `${SOLID} ${INTENT.accent}`,
        accent: `${SOLID} ${INTENT.accent}`,
        secondary: SOLID,
        outline: OUTLINE,
        row: "bg-transparent text-inherit hover:bg-transparent hover:text-foreground active:brightness-100",
        ghost: GHOST,
        success: `${SOFT} ${INTENT.success}`,
        warning: `${SOFT} ${INTENT.warning}`,
        danger: `${SOFT} ${INTENT.danger}`,
        destructive: `${SOLID} ${INTENT.danger}`,
        link: LINK,
        solid: SOLID,
        soft: SOFT,
        bare: BARE,
        inverse: INVERSE,
        segmented: SEGMENTED,
      },
      size: {
        default: "h-(--h-control-base) gap-2 px-3 text-sm md:px-2.5 [&_svg:not([class*='size-'])]:size-(--icon-base) has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-(--h-control-xs) gap-1.5 px-2 text-xs [&_svg:not([class*='size-'])]:size-(--icon-xs) has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        sm: "h-(--h-control-sm) gap-1.5 px-2.5 text-xs md:px-2 [&_svg:not([class*='size-'])]:size-(--icon-sm) has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-(--h-control-lg) gap-2 px-4 text-sm [&_svg:not([class*='size-'])]:size-(--icon-base) has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-(--h-control-base) [&_svg:not([class*='size-'])]:size-(--icon-base)",
        "icon-xs": "size-(--h-control-xs) [&_svg:not([class*='size-'])]:size-(--icon-xs)",
        "icon-sm": "size-(--h-control-sm) [&_svg:not([class*='size-'])]:size-(--icon-sm)",
        "icon-lg": "size-(--h-control-lg) [&_svg:not([class*='size-'])]:size-(--icon-lg)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** Wraps a button icon so leading/trailing icons sit optically flush; `loading` swaps in a spinner. */
function ButtonIcon({ side = "leading", loading = false, className, children, ...props }: React.ComponentProps<"span"> & { side?: "leading" | "trailing" | "only"; loading?: boolean }) {
  return (
    <span
      data-slot="button-icon"
      data-side={side}
      className={cn("inline-flex shrink-0 items-center justify-center", side === "leading" && "-ml-0.5", side === "trailing" && "-mr-0.5", side === "only" && "-mx-0.5", className)}
      {...props}
    >
      {loading ? <Loader aria-hidden className="size-[1em]" /> : children}
    </span>
  )
}

function Button({
  className,
  variant = "default",
  size = "default",
  animateWidth = false,
  render,
  children,
  ref,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Base UI `render` prop: render a link or other element with button styling, e.g. `render={<Link to="/x" />}`. */
    render?: React.ReactElement
    /** Animate an intrinsic label/content change; ordinary controls remain observer-free. */
    animateWidth?: boolean
  }) {
  // A changed element kind must rebind the observer to the replacement node.
  const motionRef = React.useMemo<React.RefObject<HTMLElement | null>>(() => ({ current: null }), [render?.type])
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

  return useRender({
    defaultTagName: "button",
    render,
    ref: composedRef,
    props: {
      "data-slot": "button",
      "data-variant": variant,
      "data-size": size,
      className: cn(buttonVariants({ variant, size, className })),
      ...props,
      children,
    },
  })
}

export { Button, ButtonIcon, buttonVariants }
