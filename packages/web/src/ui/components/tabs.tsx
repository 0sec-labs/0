"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "../lib/utils.js"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className as string | undefined
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center gap-1 rounded-none bg-transparent p-0 text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:rounded-[var(--radius-menu,12px)] data-[variant=line]:rounded-none data-[variant=line]:border-0 data-[variant=line]:bg-transparent data-[variant=line]:p-0",
  {
    variants: {
      variant: {
        default: "",
        line: "gap-1",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className as string | undefined)}
      {...props}
    />
  )
}

const tabsTriggerClasses = cn(
        "relative inline-flex h-7 flex-none items-center justify-center gap-2 rounded-md border border-transparent px-2.5 py-0 text-sm font-medium whitespace-nowrap text-muted-foreground-1 transition-[background-color,border-color,color] duration-[var(--ui-duration-fast,120ms)] motion-reduce:transition-none group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:rounded-[var(--radius-control,8px)] group-data-[orientation=vertical]/tabs:px-3 group-data-[orientation=vertical]/tabs:py-1.5 hover:text-foreground focus-visible:outline-ring-inset disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:h-7 group-data-[variant=line]/tabs-list:flex-none group-data-[variant=line]/tabs-list:rounded-md group-data-[variant=line]/tabs-list:px-2.5 group-data-[variant=line]/tabs-list:py-0 group-data-[variant=line]/tabs-list:text-muted-foreground-1 group-data-[variant=line]/tabs-list:data-[active]:border-transparent group-data-[variant=line]/tabs-list:data-[active]:bg-secondary group-data-[variant=line]/tabs-list:data-[active]:text-foreground group-data-[variant=line]/tabs-list:data-[active]:shadow-none",
        "data-[active]:bg-secondary data-[active]:text-foreground",
)

function TabsTrigger({
  className,
  ...props
}: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        tabsTriggerClasses,
        className as string | undefined
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className as string | undefined)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants, tabsTriggerClasses }
