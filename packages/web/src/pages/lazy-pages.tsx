import { lazy, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { LoadingState } from "@/components/state-panel";

/** Route-level code splitting. Console (the landing page) stays eager in operations-app. */
const loaders = {
  findings: () => import("@/pages/findings-page"),
  console: () => import("@/pages/console-page"),
  palette: () => import("@/components/command-palette"),
  scans: () => import("@/pages/scans-page"),
  saved: () => import("@/pages/saved-conversation-page"),
  learning: () => import("@/pages/learning-page"),
  engagements: () => import("@/pages/engagements-page"),
  workflows: () => import("@/pages/workflows-page"),
  apiAccess: () => import("@/pages/findings-api-access-page"),
  team: () => import("@/pages/team-settings-page"),
  skills: () => import("@/pages/skills-page"),
  workers: () => import("@/pages/workers-page"),
  controls: () => import("@/pages/console-controls-page"),
  sentinels: () => import("@/pages/sentinels-page"),
  extensions: () => import("@/pages/extensions-page"),
  skillCatalog: () => import("@/pages/skill-catalog-detail-page"),
} as const;

export type RouteName = keyof typeof loaders;

const failedRoutes = new Set<() => void>();
/** Give every route whose chunk failed a fresh import; call before re-rendering it. */
export function retryFailedRoutes() {
  failedRoutes.forEach(renew => renew());
  failedRoutes.clear();
}

/** React.lazy caches a rejected import forever, so a failed route is renewed on request (see retryFailedRoutes), not automatically. */
function lazyRoute<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const attempt = () => load().then(component => ({ default: component }), (error: unknown) => { failedRoutes.add(renew); throw error; });
  const renew = () => { Inner = lazy(attempt) as ComponentType<P>; };
  let Inner = lazy(attempt) as ComponentType<P>;
  return function LazyRoute(props: P) { return <Inner {...props} />; };
}

export const FindingsPage = lazyRoute(() => loaders.findings().then((m) => m.FindingsPage));
export const ConsolePage = lazyRoute(() => loaders.console().then((m) => m.ConsolePage));
export const CommandPalette = lazyRoute(() => loaders.palette().then((m) => m.CommandPalette));
export const ReportPage = lazyRoute(() => loaders.scans().then((m) => m.ReportPage));
export const SavedConversationPage = lazyRoute(() => loaders.saved().then((m) => m.SavedConversationPage));
export const LearningPage = lazyRoute(() => loaders.learning().then((m) => m.LearningPage));
export const EngagementsPage = lazyRoute(() => loaders.engagements().then((m) => m.EngagementsPage));
export const WorkflowsPage = lazyRoute(() => loaders.workflows().then((m) => m.WorkflowsPage));
export const FindingsApiAccessPage = lazyRoute(() => loaders.apiAccess().then((m) => m.FindingsApiAccessPage));
export const TeamSettingsPage = lazyRoute(() => loaders.team().then((m) => m.TeamSettingsPage));
export const SkillsPage = lazyRoute(() => loaders.skills().then((m) => m.SkillsPage));
export const WorkersPage = lazyRoute(() => loaders.workers().then((m) => m.WorkersPage));
export const SentinelsPage = lazyRoute(() => loaders.sentinels().then((m) => m.SentinelsPage));
export const SentinelPage = lazyRoute(() => loaders.sentinels().then((m) => m.SentinelPage));
export const ExtensionsPage = lazyRoute(() => loaders.extensions().then((m) => m.ExtensionsPage));
export const SkillCatalogDetailPage = lazyRoute(() => loaders.skillCatalog().then((m) => m.SkillCatalogDetailPage));
export const WebConsoleControlsPage = lazyRoute(() => loaders.controls().then((m) => m.WebConsoleControlsPage));

const started = new Set<RouteName>();
export function prefetchRoute(name: RouteName) {
  if (started.has(name)) return;
  started.add(name);
  void loaders[name]().catch(() => started.delete(name));
}

const CONTROL_ROUTES = ["connections", "models", "settings", "doctor", "tools", "project", "fix"];
export function routeForPath(pathname: string): RouteName | undefined {
  const [first = "", second] = pathname.split("/").filter(Boolean);
  if (first === "console") return second === "saved" ? "saved" : undefined;
  if (first === "chats") return second === "saved" ? "saved" : "console";
  if (first === "plugins" && second === "skills") return "skills";
  if (first === "extensions") return "extensions";
  if (CONTROL_ROUTES.includes(first)) return "controls";
  switch (first) {
    case "automations": return "workflows";
    case "sentinels": return "sentinels";
    case "api-access": return "apiAccess";
    case "team": return "team";
    case "skills": return "skills";
    case "learning": return "learning";
    case "engagements": return "engagements";
    case "findings": return "findings";
    case "workers": return "workers";
    case "runs": return "scans";
    default: return undefined;
  }
}

/** Chunks that carry dockview/markdown: fetched on navigation or hover only, never by idle warming. */
const ON_DEMAND = new Set<RouteName>(["console", "palette", "saved", "learning", "skills", "workflows", "sentinels"]);

/** Warm the other routes once the browser is idle, then on link hover/focus. */
export function useRoutePrefetch() {
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    let handle: number | undefined;
    // Let the current route settle first so warming never competes with its first load.
    const delay = window.setTimeout(() => { handle = idle(() => {
      (Object.keys(loaders) as RouteName[]).filter(name => !ON_DEMAND.has(name)).forEach((name, index) => window.setTimeout(() => prefetchRoute(name), index * 50));
    }, { timeout: 8000 } as IdleRequestOptions) as number; }, 3000);
    const warm = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      try {
        const name = routeForPath(new URL((anchor as HTMLAnchorElement).href, window.location.href).pathname);
        if (name) prefetchRoute(name);
      } catch { /* ignore malformed hrefs */ }
    };
    document.addEventListener("pointerover", warm, { passive: true });
    document.addEventListener("focusin", warm);
    return () => {
      window.clearTimeout(delay);
      if (handle !== undefined) (cancel as (id: number) => void)(handle);
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("focusin", warm);
    };
  }, []);
}

/** Renders nothing for `delay` ms so fast chunk loads never flash a skeleton. */
export function DelayedFallback({ delay = 150, children }: { delay?: number; children: ReactNode }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setShow(true), delay);
    return () => window.clearTimeout(id);
  }, [delay]);
  return show ? <>{children}</> : null;
}

export function PageFallback() {
  return <DelayedFallback><LoadingState label="Loading" variant="detail" /></DelayedFallback>;
}
