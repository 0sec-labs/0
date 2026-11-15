import { useEffect } from "react";

const SUFFIX = "0security";

const TITLES: Array<[RegExp, string]> = [
  [/^\/chats(?:\/|$)/, "Home"],
  [/^\/(?:findings|threads|operations)(?:\/|$)/, "Findings"],
  [/^\/(?:runs|scans)(?:\/|$)/, "Report"],
  [/^\/(?:automations|workflows|audits|launcher|launch)(?:\/|$)/, "Automations"],
  [/^\/sentinels(?:\/|$)/, "Sentinels"],
  [/^\/plugins\/skills(?:\/|$)/, "Skills"],
  [/^\/plugins\/explore(?:\/|$)/, "Explore plugins"],
  [/^\/plugins(?:\/|$)/, "Plugins"],
  [/^\/(?:settings|project|fix)(?:\/|$)/, "Settings"],
  [/^\/connections(?:\/|$)/, "Models"],
  [/^\/models(?:\/|$)/, "Models"],
  [/^\/doctor(?:\/|$)/, "Diagnostics"],
  [/^\/tools(?:\/|$)/, "Tools"],
  [/^\/api-access(?:\/|$)/, "API access"],
  [/^\/team(?:\/|$)/, "Team"],
  [/^\/learning(?:\/|$)/, "Lessons"],
  [/^\/scope(?:\/|$)/, "Reports"],
  [/^\/(?:computers|engines|workers)(?:\/|$)/, "Computers"],
];

const KNOWN = /^\/(?:onboarding|setup|console|dashboard|live|engagements|skills)(?:\/|$)|^\/$/;

/** Per-route document title, e.g. "Findings · 0security". Unknown paths read as a 404. */
export function pageTitleFor(pathname: string): string {
  const hit = TITLES.find(([pattern]) => pattern.test(pathname));
  if (hit) return `${hit[1]} · ${SUFFIX}`;
  return KNOWN.test(pathname) ? `Command Center · ${SUFFIX}` : `Page not found · ${SUFFIX}`;
}

export function usePageTitle(pathname: string) {
  useEffect(() => { document.title = pageTitleFor(pathname); }, [pathname]);
}
