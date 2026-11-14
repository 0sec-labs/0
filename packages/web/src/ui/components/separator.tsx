"use client"

import * as React from "react"
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "../lib/utils.js"

function Separator({
  className,
  orientation = "horizontal",
  decorative: _decorative,
  ...props
}: SeparatorPrimitive.Props & { /** Kept for source compatibility; separators are always presentational here. */ decorative?: boolean }) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className as string | undefined
      )}
      {...props}
    />
  )
}

export { Separator }
