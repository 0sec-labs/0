import * as React from "react";
import { Button } from "../components/button.js";

/**
 * Base UI triggers already render a <button>. Call sites that put a `Button`/`<button>` inside a
 * trigger (the old Kumo/Radix style) would nest buttons, so a lone button child becomes the
 * rendered element instead. An explicit `render` is left untouched.
 */
export function triggerRender(render: unknown, children: React.ReactNode): { render?: React.ReactElement; children: React.ReactNode } {
  if (render) return { children };
  const only = React.Children.count(children) === 1 ? React.Children.toArray(children)[0] : null;
  if (React.isValidElement<{ children?: React.ReactNode }>(only) && (only.type === Button || only.type === "button")) {
    return { render: only, children: only.props.children };
  }
  return { children };
}
