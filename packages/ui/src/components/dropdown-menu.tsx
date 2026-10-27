import { forwardRef, type ComponentProps, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { cn } from "../lib/utils.js";
import { DropdownMenu as KumoDropdownMenu } from "@cloudflare/kumo/components/dropdown";

// Position the portal itself above navigation, not just its popup child.
const Content = forwardRef<ComponentRef<typeof KumoDropdownMenu.Content>, ComponentPropsWithoutRef<typeof KumoDropdownMenu.Content>>(({ style, className, ...props }, ref) => (
  <KumoDropdownMenu.Content {...props} ref={ref} className={cn("ui-menu-surface ui-control-popup min-w-48 rounded-2xl border-[length:var(--ui-frame-border-width,1px)] border-border bg-popover p-1 text-popover-foreground shadow-[var(--ui-panel-shadow,0_8px_24px_rgb(0_0_0_/_16%))]", className)} style={{ zIndex: 60, ...style }} />
));
Content.displayName = "DropdownMenuContent";
const Label = forwardRef<ComponentRef<typeof KumoDropdownMenu.Label>, ComponentPropsWithoutRef<typeof KumoDropdownMenu.Label>>(({ className, ...props }, ref) => <KumoDropdownMenu.Label {...props} ref={ref} className={cn("ui-menu-section", className)} />);
Label.displayName = "DropdownMenuLabel";
export const DropdownMenu: typeof KumoDropdownMenu = Object.assign(
  function DropdownMenu(props: ComponentProps<typeof KumoDropdownMenu>) { return <KumoDropdownMenu {...props} />; },
  KumoDropdownMenu,
  { Content, Label },
);
