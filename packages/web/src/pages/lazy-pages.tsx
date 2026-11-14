import { lazy, useEffect, useState, type ReactNode } from "react";
import { LoadingState } from "@/components/state-panel";

/** Route-level code splitting. Console (the landing page) stays eager in operations-app. */
const loaders = {
  findings: () => import("@/pages/findings-page"),
  live: () => import("@/pages/live-page"),
  overview: () => import("@/pages/overview-page"),
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
} as const;

export type RouteName = keyof typeof loaders;

export const FindingsPage = lazy(() => loaders.findings().then((m) => ({ default: m.FindingsPage })));
export const LivePage = lazy(() => loaders.live().then((m) => ({ default: m.LivePage })));
export const OverviewPage = lazy(() => loaders.overview().then((m) => ({ default: m.OverviewPage })));
export const ScansPage = lazy(() => loaders.scans().then((m) => ({ default: m.ScansPage })));
export const SavedConversationPage = lazy(() => loaders.saved().then((m) => ({ default: m.SavedConversationPage })));
export const LearningPage = lazy(() => loaders.learning().then((m) => ({ default: m.LearningPage })));
export const EngagementsPage = lazy(() => loaders.engagements().then((m) => ({ default: m.EngagementsPage })));
export const WorkflowsPage = lazy(() => loaders.workflows().then((m) => ({ default: m.WorkflowsPage })));
export const FindingsApiAccessPage = lazy(() => loaders.apiAccess().then((m) => ({ default: m.FindingsApiAccessPage })));
export const TeamSettingsPage = lazy(() => loaders.team().then((m) => ({ default: m.TeamSettingsPage })));
export const SkillsPage = lazy(() => loaders.skills().then((m) => ({ default: m.SkillsPage })));
export const WorkersPage = lazy(() => loaders.workers().then((m) => ({ default: m.WorkersPage })));
export const SentinelsPage = lazy(() => loaders.sentinels().then((m) => ({ default: m.SentinelsPage })));
export const SentinelPage = lazy(() => loaders.sentinels().then((m) => ({ default: m.SentinelPage })));
export const WebConsoleControlsPage = lazy(() => loaders.controls().then((m) => ({ default: m.WebConsoleControlsPage })));

const started = new Set<RouteName>();
export function prefetchRoute(name: RouteName) {
  if (started.has(name)) return;
  started.add(name);
  void loaders[name]().catch(() => started.delete(name));
}

const CONTROL_ROUTES = ["onboarding", "connections", "models", "settings", "plugins", "doctor", "tools", "project", "fix"];
export function routeForPath(pathname: string): RouteName | undefined {
  const [first = "", second] = pathname.split("/").filter(Boolean);
  if (first === "console") return second === "saved" ? "saved" : undefined;
  if (CONTROL_ROUTES.includes(first)) return "controls";
  switch (first) {
    case "automations": return "workflows";
    case "sentinels": return "sentinels";
    case "api-access": return "apiAccess";
    case "team": return "team";
    case "skills": return "skills";
    case "learning": return "learning";
    case "engagements": return "engagements";
    case "dashboard": return "overview";
    case "findings": return "findings";
    case "workers": return "workers";
    case "runs": return "scans";
    case "live": return "live";
    default: return undefined;
  }
}

/** Warm the other routes once the browser is idle, then on link hover/focus. */
export function useRoutePrefetch() {
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(() => {
      (Object.keys(loaders) as RouteName[]).forEach((name, index) => window.setTimeout(() => prefetchRoute(name), index * 50));
    }, { timeout: 5000 } as IdleRequestOptions);
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
      (cancel as (id: number) => void)(handle as number);
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
