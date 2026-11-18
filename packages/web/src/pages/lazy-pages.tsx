import { lazy, useEffect, useEffectEvent, useState, type ComponentType, type ReactNode } from "react";
import { SKELETON_DELAY_MS } from "@/lib/pending-gate";
import { createIntentPrefetcher, intentTarget, type IntentTarget } from "@/lib/intent-prefetch";
import { LoadingState } from "@/components/state-panel";

/** Route-level code splitting. Console (the landing page) stays eager in operations-app. */
const loaders = {
  findings: () => import("@/pages/findings-page"),
  console: () => import("@/pages/console-page"),
  palette: () => import("@/components/command-palette"),
  saved: () => import("@/pages/saved-conversation-page"),
  memory: () => import("@/pages/memory-page"),
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
export const SavedConversationPage = lazyRoute(() => loaders.saved().then((m) => m.SavedConversationPage));
export const MemoryPage = lazyRoute(() => loaders.memory().then((m) => m.MemoryPage));
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

const CONTROL_ROUTES = ["connections", "models", "settings", "doctor", "tools", "project"];
export function routeForPath(pathname: string): RouteName | undefined {
  const [first = "", second] = pathname.split("/").filter(Boolean);
  if (first === "chats") return second === "saved" ? "saved" : "console";
  if (CONTROL_ROUTES.includes(first)) return "controls";
  switch (first) {
    case "agents": return "sentinels";
    case "api-access": return "apiAccess";
    case "team": return "team";
    case "skills": return "skills";
    case "memory": return "memory";
    case "extensions": return "extensions";
    case "findings": return "findings";
    case "computers": return "workers";
    default: return undefined;
  }
}

/** Chunks that carry dockview/markdown: fetched on navigation or hover only, never by idle warming. */
const ON_DEMAND = new Set<RouteName>(["console", "palette", "saved", "memory", "skills", "sentinels"]);

/**
 * Warm the other routes once the browser is idle, then on intent: a link or finding row held under the pointer
 * (or focused) for 50 ms prefetches its chunk and, through `warmData`, its first query.
 */
export function useRoutePrefetch(warmData?: (target: IntentTarget) => void) {
  const warm = useEffectEvent((target: IntentTarget) => {
    if (target.kind === "path") { const name = routeForPath(target.pathname); if (name) prefetchRoute(name); }
    warmData?.(target);
  });
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    let handle: number | undefined;
    // Let the current route settle first so warming never competes with its first load.
    const delay = window.setTimeout(() => { handle = idle(() => {
      (Object.keys(loaders) as RouteName[]).filter(name => !ON_DEMAND.has(name)).forEach((name, index) => window.setTimeout(() => prefetchRoute(name), index * 50));
    }, { timeout: 8000 } as IdleRequestOptions) as number; }, 3000);
    const intent = createIntentPrefetcher(target => warm(target));
    const enter = (event: Event) => intent.enter(intentTarget(event.target as Element | null, window.location.href));
    const leave = () => intent.cancel();
    document.addEventListener("pointerover", enter, { passive: true });
    document.addEventListener("pointerout", leave, { passive: true });
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    return () => {
      window.clearTimeout(delay);
      if (handle !== undefined) (cancel as (id: number) => void)(handle);
      intent.cancel();
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
    };
  }, []);
}

/** Renders nothing for `delay` ms so fast chunk loads never flash a skeleton. */
export function DelayedFallback({ delay = SKELETON_DELAY_MS, children }: { delay?: number; children: ReactNode }) {
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
