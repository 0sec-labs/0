import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { DesktopConsoleSession } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { getNotificationPrefs, notificationPermission, shouldDeliver, showNotification, useNotificationPrefs } from "@/lib/notifications";
import { queryKeys } from "@/queries";
import { LIST_STALE_MS } from "./workspace-events";
import { sessionsRefetchInterval } from "./session-polling";
import { NOTIFICATION_EVENTS, createDeduper, notificationsForSessions, type MissionState } from "./notification-transitions";

const toState = (session: DesktopConsoleSession): MissionState => ({ id: session.id, title: session.title, status: session.status, updatedAt: session.updatedAt });

/** Headless: watches the shared sessions list (also patched by the open chat's event feed) and raises browser notifications. */
export function MissionNotifications() {
  const prefs = useNotificationPrefs();
  const { listConsoleSessions, getConsoleSnapshot } = useBackendApi();
  const navigate = useNavigate();
  const sessions = useQuery({ queryKey: queryKeys.consoleSessions(), queryFn: ({ signal }) => listConsoleSessions(signal), staleTime: LIST_STALE_MS, refetchInterval: sessionsRefetchInterval, enabled: prefs.enabled });
  const previous = useRef<MissionState[] | undefined>(undefined);
  const dedupe = useRef(createDeduper());
  const data = sessions.data;
  useEffect(() => {
    if (!prefs.enabled) { previous.current = undefined; return; }
    if (!data) return;
    const next = data.map(toState);
    const before = previous.current;
    previous.current = next;
    if (!before) return;
    const controller = new AbortController();
    void (async () => {
      for (const request of notificationsForSessions(before, next)) {
        let event = request.event;
        let key = request.key;
        // The list only says "waiting": the snapshot tells an approval from a question. Only the kind is read, never its text.
        if (event === "mission-approval") {
          const decision = await getConsoleSnapshot(request.missionId, controller.signal, 1).then(snapshot => snapshot.pendingDecisions[0], () => undefined);
          if (decision?.kind === "operator-question") { event = "mission-question"; key = `${request.missionId}:${event}:${decision.id}`; } else if (decision) key = `${request.missionId}:${event}:${decision.id}`;
        }
        if (controller.signal.aborted) return;
        const live = getNotificationPrefs();
        if (!shouldDeliver(live, event, { hidden: document.hidden, permission: notificationPermission() }) || !dedupe.current(key)) continue;
        showNotification({ title: NOTIFICATION_EVENTS.find(item => item.id === event)!.title, body: request.missionTitle, tag: key, sound: live.sound, onClick: () => navigate(`/chats/${encodeURIComponent(request.missionId)}`) });
      }
    })();
    return () => controller.abort();
  }, [data, prefs.enabled, getConsoleSnapshot, navigate]);
  return null;
}
