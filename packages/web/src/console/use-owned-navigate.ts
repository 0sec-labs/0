import { useCallback } from "react";
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from "react-router-dom";

/** Console links stay on the host that owns the open chat: `/console…` targets gain a `host` param. */
export function useOwnedNavigate(backendId: string): NavigateFunction {
  const routeNavigate = useNavigate();
  return useCallback(
    ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === "number") return routeNavigate(to);
      if (typeof to === "string" && /^\/console(?:[/?#]|$)/.test(to)) {
        const owned = new URL(to, window.location.origin);
        owned.searchParams.set("host", backendId);
        return routeNavigate(`${owned.pathname}${owned.search}${owned.hash}`, options);
      }
      return routeNavigate(to, options);
    }) as NavigateFunction,
    [routeNavigate, backendId],
  );
}
