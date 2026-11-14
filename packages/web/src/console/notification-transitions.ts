import type { DesktopConsoleSessionStatus } from "@0/engine/shared";

/** Events a mission can raise. Scan and fix events are declared so preferences are stable; they are raised by `scan`/`fix` callers. */
export type NotificationEvent = "mission-finished" | "mission-approval" | "mission-question" | "scan-finished" | "fix-ready";
export const NOTIFICATION_EVENTS: readonly { id: NotificationEvent; label: string; description: string; title: string }[] = [
  { id: "mission-finished", label: "Mission finished", description: "A mission completed its turn and is ready for you.", title: "Mission finished" },
  { id: "mission-approval", label: "Mission needs your approval", description: "A mission is paused until you approve or deny an action.", title: "Approval needed" },
  { id: "mission-question", label: "Mission asked a question", description: "A mission is waiting for your answer.", title: "Question from a mission" },
  { id: "scan-finished", label: "Scan finished", description: "A scan completed.", title: "Scan finished" },
  { id: "fix-ready", label: "Fix ready or pull request opened", description: "A fix is ready for review.", title: "Fix ready" },
];

/** The minimum a transition needs: never finding text, only ids, status and the mission title. */
export type MissionState = { id: string; title?: string; status: DesktopConsoleSessionStatus; updatedAt?: string; attention?: { kind: "approval" | "question"; id?: string } };
export type NotificationRequest = { event: NotificationEvent; missionId: string; missionTitle: string; key: string };

const ACTIVE = new Set<DesktopConsoleSessionStatus>(["working", "waiting"]);

/** Pure: which notifications does moving from `prev` to `next` warrant. A first sighting (no `prev`) raises nothing. */
export function notificationsForTransition(prev: MissionState | undefined, next: MissionState): NotificationRequest[] {
  if (!prev || prev.status === next.status && prev.attention?.id === next.attention?.id) return [];
  const missionTitle = next.title?.trim() || "Untitled mission";
  const make = (event: NotificationEvent, token: string | undefined): NotificationRequest => ({ event, missionId: next.id, missionTitle, key: `${next.id}:${event}:${token ?? ""}` });
  if (next.status === "waiting") {
    if (prev.status === "waiting" && !next.attention?.id) return [];
    const kind = next.attention?.kind ?? "approval";
    return [make(kind === "question" ? "mission-question" : "mission-approval", next.attention?.id ?? next.updatedAt)];
  }
  if (next.status === "ready" && ACTIVE.has(prev.status)) return [make("mission-finished", next.updatedAt)];
  return [];
}

/** Diff two polls of the sessions list. Missions new to `next` are ignored. */
export function notificationsForSessions(prev: readonly MissionState[], next: readonly MissionState[]): NotificationRequest[] {
  const before = new Map(prev.map(item => [item.id, item]));
  return next.flatMap(item => notificationsForTransition(before.get(item.id), item));
}

/** Remembers recent keys so one mission+event never notifies twice (polls and event feeds overlap). */
export function createDeduper(limit = 200) {
  const seen = new Set<string>();
  return (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value as string);
    return true;
  };
}
