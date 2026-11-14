import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";

type AnyProps = Record<string, unknown>;

function setRef<T>(ref: React.Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as React.RefObject<T | null>).current = node;
}

/** Compose several refs into one callback ref. */
export function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return node => { for (const ref of refs) setRef(ref, node); };
}

/**
 * Merge props into the single child element, replacing the former Radix `Slot`.
 * Handlers chain, classNames and styles merge, and the child's refs are preserved.
 */
export function Slot({ children, ref, ...props }: React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement>; children?: React.ReactNode }) {
  if (!React.isValidElement<AnyProps>(children)) return null;
  const childRef = (children.props as { ref?: React.Ref<HTMLElement> }).ref;
  return React.cloneElement(children, { ...mergeProps(props as AnyProps, children.props), ref: composeRefs(ref, childRef) } as AnyProps);
}

/**
 * Convert the `asChild` convention into Base UI's `render` prop.
 * With `asChild`, the single child becomes the rendered element and its own children become the content.
 */
export function asChildToRender(asChild: boolean | undefined, children: React.ReactNode): { render?: React.ReactElement; children: React.ReactNode } {
  if (asChild && React.isValidElement<{ children?: React.ReactNode }>(children)) {
    return { render: children, children: children.props.children };
  }
  return { children };
}
