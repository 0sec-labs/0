import * as React from "react";
import { Button } from "../components/button.js";
import { asChildToRender } from "./render.js";

/**
 * Base UI triggers already render a <button>. Call sites that put a `Button`/`<button>` inside a
 * trigger (the old Kumo/Radix style) would nest buttons, so a lone button child becomes the
 * rendered element instead. Explicit `asChild` and `render` keep working unchanged.
 */
export function triggerRender(asChild: boolean | undefined, render: unknown, children: React.ReactNode): { render?: React.ReactElement; children: React.ReactNode } {
  if (render) return { children };
  const only = React.Children.count(children) === 1 ? React.Children.toArray(children)[0] : null;
  const isButton = React.isValidElement(only) && (only.type === Button || only.type === "button");
  return asChildToRender(asChild || isButton, children);
}
