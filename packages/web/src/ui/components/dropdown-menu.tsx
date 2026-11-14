import { Children, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import { cn } from "../lib/utils.js";
import { triggerRender } from "../lib/trigger.js";

/** Product dropdown menu on Base UI Menu; keeps the Trigger/Content/Item/Label/Group compatibility API. */
function DropdownMenu({ onOpenChange, ...props }: Omit<MenuPrimitive.Root.Props, "onOpenChange"> & { onOpenChange?: (open: boolean) => void }) {
  return <MenuPrimitive.Root onOpenChange={open => onOpenChange?.(open)} {...props} />;
}

function Trigger({ asChild, children, ...props }: MenuPrimitive.Trigger.Props & { asChild?: boolean }) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...triggerRender(asChild, props.render, children)} {...props} />;
}

type ContentProps = Omit<MenuPrimitive.Positioner.Props, "className"> & { className?: string; container?: ComponentProps<typeof MenuPrimitive.Portal>["container"] };
function Content({ className, children, container, side = "bottom", sideOffset = 8, align = "center", ...props }: ContentProps) {
  return <MenuPrimitive.Portal container={container}>
    <MenuPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="z-[60] outline-none" {...props}>
      <MenuPrimitive.Popup data-slot="dropdown-menu-content" className={cn("ui-popup max-w-[calc(100vw-24px)] max-h-[min(28rem,calc(100dvh-2rem))] overscroll-contain flex min-w-48 origin-(--transform-origin) flex-col overflow-y-auto scroll-fade-y rounded-[var(--radius-overlay,8px)] border-[0.5px] border-border-2 bg-popover text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03),0_3px_9px_rgb(0_0_0/.04),0_1px_1px_rgb(0_0_0/.05))] p-1 outline-none", className)}>
        {children}
      </MenuPrimitive.Popup>
    </MenuPrimitive.Positioner>
  </MenuPrimitive.Portal>;
}

/** A plain caption. `MenuPrimitive.GroupLabel` throws (Base UI #31) outside a `Menu.Group`, and most call sites are bare. */
function Label({ className, ...props }: React.ComponentProps<"div">) {
  return <div role="presentation" {...props} className={cn("px-2 pt-2 pb-1 text-[11px] leading-[14px] font-medium text-muted-foreground", className)} />;
}

type ItemProps = Omit<MenuPrimitive.Item.Props, "className"> & {
  className?: string;
  /** Leading icon element. */
  icon?: ReactElement;
  /** Show a trailing check for the active choice. */
  selected?: boolean;
  variant?: "default" | "danger";
  children?: ReactNode;
};
function Item({ className, icon, selected, variant = "default", children, ...props }: ItemProps) {
  return <MenuPrimitive.Item {...props} data-slot="dropdown-menu-item" data-variant={variant}
    className={cn("relative flex min-h-[var(--h-menu-row,28px)] w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm leading-5 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--popover-hover,color-mix(in_oklch,var(--foreground)_8%,transparent))] data-[variant=danger]:text-destructive data-[variant=danger]:data-[highlighted]:bg-destructive/10 [&_svg:not([class*='size-'])]:size-(--icon-sm) [&_svg]:shrink-0", className)}>
    {icon}
    {Children.count(children) > 0 && children}
    {selected && <Check aria-hidden="true" className="ml-auto size-(--icon-sm) shrink-0" />}
  </MenuPrimitive.Item>;
}

function Group(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group {...props} />;
}

DropdownMenu.Trigger = Trigger;
DropdownMenu.Content = Content;
DropdownMenu.Label = Label;
DropdownMenu.Item = Item;
DropdownMenu.Group = Group;

export { DropdownMenu };
