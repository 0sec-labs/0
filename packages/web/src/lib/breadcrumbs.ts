import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { VOCAB } from "@/lib/vocabulary";
import { settingsPages } from "@/components/console-control/settings-index";

/** One crumb. `to` is absent on the current (last) crumb. */
export type Crumb = { label: string; to?: string };

const SETTINGS_LEAVES: Record<string, string> = {
  connections: "Connections", models: "Models", tools: "Tools", project: "Workspace", doctor: "Diagnostics", fix: "Fix",
};
const SETTINGS_PREFIXES = new Set(["settings", ...Object.keys(SETTINGS_LEAVES)]);

/**
 * Route -> crumbs. Returns `null` when the route has no top bar (conversations own their header, onboarding is full-bleed).
 * `dynamicLabel` is the page-supplied name of the current record (a plugin, finding, automation...); it becomes the last crumb.
 * Pure so it can be table-tested.
 */
export function resolveCrumbs(pathname: string, search = "", dynamicLabel?: string): Crumb[] | null {
  const path = pathname.replace(/^\/console(?=\/)/, "").replace(/\/+$/, "") || "/";
  const [, root = "", second] = path.split("/");
  const label = dynamicLabel?.trim() || undefined;
  const list = (leaf: string, to: string, detail?: string): Crumb[] => {
    if (second && detail) return [{ label: leaf, to }, { label: label ?? detail }];
    return label ? [{ label: leaf, to }, { label }] : [{ label: leaf }];
  };

  if (root === "chats" || root === "onboarding" || root === "setup" || root === "") return null;
  if (SETTINGS_PREFIXES.has(root) && !(root === "settings" && second)) {
    const sectionId = new URLSearchParams(search).get("section");
    const page = root === "settings"
      ? settingsPages.find(item => item.id === sectionId)?.label ?? "General"
      : SETTINGS_LEAVES[root];
    return [{ label: "Settings", to: "/settings" }, { label: page }];
  }
  switch (root) {
    case "findings": return list("Findings", "/findings", "Finding");
    case "automations": return list("Automations", "/automations", "Automation");
    case "sentinels": return list(VOCAB.sentinel.Plural, "/sentinels", VOCAB.sentinel.Singular);
    case "plugins":
      if (second === "skills") return list("Skills", "/plugins/skills");
      return list("Plugins", "/plugins", "Plugin");
    case "engines": return list("Engines", "/engines");
    case "learning": return list("Memory", "/learning");
    case "scope": return list("Scope", "/scope");
    case "runs": return label ? [{ label: "Report", to: "/findings" }, { label }] : [{ label: "Report" }];
    case "api-access": return [{ label: "Findings", to: "/findings" }, { label: "API access" }];
    case "team": return [{ label: "Settings", to: "/settings" }, { label: "Members" }];
    default: return null;
  }
}

type BreadcrumbState = { label: string | undefined; actions: ReactNode };
type BreadcrumbSetters = { setLabel: (label: string | undefined) => void; setActions: (actions: ReactNode) => void };

const StateContext = createContext<BreadcrumbState>({ label: undefined, actions: null });
// Pages only read the (stable) setters, so publishing a label or actions never re-renders the page that published them.
const SettersContext = createContext<BreadcrumbSetters | null>(null);

/** Mounted once by the shell; the top bar reads from it and pages publish into it. */
export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | undefined>();
  const [actions, setActions] = useState<ReactNode>(null);
  const setters = useMemo<BreadcrumbSetters>(() => ({ setLabel, setActions }), []);
  const state = useMemo(() => ({ label, actions }), [label, actions]);
  return createElement(SettersContext.Provider, { value: setters }, createElement(StateContext.Provider, { value: state }, children));
}

/** Read by the top bar. */
export function useBreadcrumbState(): BreadcrumbState {
  return useContext(StateContext);
}

/** Name the current record in the top bar (`Plugins > Cloudflare`). Clears itself on unmount or when `undefined`. No-op outside the shell. */
export function useBreadcrumbLabel(label: string | undefined): void {
  const setters = useContext(SettersContext);
  const setLabel = setters?.setLabel;
  useEffect(() => {
    if (!setLabel) return;
    setLabel(label);
    return () => setLabel(undefined);
  }, [setLabel, label]);
}

/** Right-aligned page actions in the top bar. Clears on unmount. No-op outside the shell. */
export function useBreadcrumbActions(actions: ReactNode): void {
  const setters = useContext(SettersContext);
  const setActions = setters?.setActions;
  useEffect(() => {
    if (!setActions) return;
    setActions(actions);
    return () => setActions(null);
  }, [setActions, actions]);
}
