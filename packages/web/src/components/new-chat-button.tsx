import { v } from "@/lib/vocabulary";
import type { ComponentProps } from "react";
import { SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shared action for a new conversation, including compact navigation links (pass `render={<Link … />}`). */
export function NewChatButton({ iconOnly = false, variant = "ghost", size, children: _children, ...props }: ComponentProps<typeof Button> & { iconOnly?: boolean }) {
  return <Button type="button" {...props} variant={variant} size={size ?? (iconOnly ? "icon" : "default")} aria-label={props["aria-label"] ?? v("New {mission}")}>
    <SquarePen aria-hidden="true" data-icon="inline-start" className="size-4" />{!iconOnly && <span className="truncate">{v("New {mission}")}</span>}
  </Button>;
}
