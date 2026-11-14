import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import { SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shared action for a new conversation, including compact navigation links. */
export function NewChatButton({ iconOnly = false, asChild = false, children, variant = "ghost", size, ...props }: ComponentProps<typeof Button> & { iconOnly?: boolean }) {
  const content = <><SquarePen aria-hidden="true" data-icon="inline-start" className="size-4" />{!iconOnly && <span className="truncate">New chat</span>}</>;
  return <Button type="button" {...props} asChild={asChild} variant={variant} size={size ?? (iconOnly ? "icon" : "default")} aria-label={props["aria-label"] ?? "New chat"}>
    {asChild && isValidElement<{ children?: ReactNode }>(children) ? cloneElement(children, undefined, content) : content}
  </Button>;
}
