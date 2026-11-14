import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils.js"
import { Slot } from "../lib/render.js"

const chipVariants = cva(
  "group/chip relative inline-flex w-fit shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border-[0.5px] border-border-2 bg-button font-medium text-nowrap whitespace-nowrap text-muted-foreground-1 transition-colors duration-100 outline-none select-none hover:bg-button-hover hover:text-foreground focus-visible:outline-ring-inset active:brightness-97 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55 data-[popup-open]:bg-button-hover data-[popup-open]:text-foreground pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:size-full pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[''] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      size: {
        xs: "h-(--h-control-xs) px-1.5 text-2xs [&_svg:not([class*='size-'])]:size-(--icon-xs)",
        sm: "h-(--h-control-sm) px-2.5 text-xs [&_svg:not([class*='size-'])]:size-(--icon-sm)",
      },
      shape: { rounded: "rounded-md", pill: "rounded-full" },
    },
    defaultVariants: { size: "sm", shape: "rounded" },
  }
)

/** Hairline-bordered suggestion chip; a button by default, or any element via asChild. */
function Chip({ className, size, shape, asChild = false, type, ...props }: React.ComponentProps<"button"> & VariantProps<typeof chipVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button"
  return <Comp data-slot="chip" {...(asChild ? {} : { type: type ?? "button" })} className={cn(chipVariants({ size, shape }), className)} {...props} />
}

export { Chip, chipVariants }
