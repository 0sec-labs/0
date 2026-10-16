import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-6 overflow-hidden rounded-3xl border border-border/40 bg-card py-6 text-sm text-card-foreground has-[>img:first-child]:pt-0 data-[size=sm]:gap-4 data-[size=sm]:py-4 *:[img:first-child]:rounded-t-3xl *:[img:last-child]:rounded-b-3xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1.5 rounded-t-3xl px-6 group-data-[size=sm]/card:px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-6 group-data-[size=sm]/card:[.border-b]:pb-4",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-sans text-base font-medium", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6 group-data-[size=sm]/card:px-4", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-3xl px-6 group-data-[size=sm]/card:px-4 [.border-t]:pt-6 group-data-[size=sm]/card:[.border-t]:pt-4",
        className
      )}
      {...props}
    />
  )
}

function CardEyebrow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-eyebrow"
      className={cn(
        "text-xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CardList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-list"
      className={cn("divide-y divide-border/30", className)}
      {...props}
    />
  )
}

const cardListItemVariants = cva("px-4 py-3 text-sm transition-colors duration-150 motion-reduce:transition-none", {
  variants: {
    interactive: {
      true: "hover:bg-muted/60 hover:text-foreground",
      false: "",
    },
    selected: {
      true: "bg-muted text-foreground",
      false: "",
    },
  },
  defaultVariants: {
    interactive: false,
    selected: false,
  },
})

function CardListItem({
  className,
  interactive,
  selected,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardListItemVariants>) {
  return (
    <div
      data-slot="card-list-item"
      className={cn(cardListItemVariants({ interactive, selected }), className)}
      {...props}
    />
  )
}

function CardEmpty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-empty"
      className={cn(
        "rounded-3xl bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardEmpty,
  CardEyebrow,
  CardList,
  CardListItem,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
