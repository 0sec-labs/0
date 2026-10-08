import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamChange, TeamClient, TeamWorkspacePresence } from "@/lib/team-client";

type Observer = { overview(value: TeamWorkspacePresence): void; connection(value: boolean): void; changed(value: TeamChange): void };
const subscriptions = new WeakMap<TeamClient, { controller: AbortController; observers: Set<Observer>; connected: boolean; latest?: TeamWorkspacePresence }>();
function observe(client: TeamClient, observer: Observer): () => void {
  let shared = subscriptions.get(client);
  if (!shared) {
    shared = { controller: new AbortController(), observers: new Set(), connected: false };
    subscriptions.set(client, shared);
    const active = shared;
    void client.subscribeOverview(value => { active.latest = value; for (const item of active.observers) item.overview(value); }, {
      signal: active.controller.signal,
      onConnectionChange: value => { active.connected = value; for (const item of active.observers) item.connection(value); },
      onError: () => { active.connected = false; for (const item of active.observers) item.connection(false); },
      onChanged: value => { for (const item of active.observers) item.changed(value); },
    }).catch(() => { active.connected = false; for (const item of active.observers) item.connection(false); });
  }
  shared.observers.add(observer);
  observer.connection(shared.connected);
  if (shared.latest) observer.overview(shared.latest);
  const active = shared;
  return () => { active.observers.delete(observer); if (!active.observers.size) { active.controller.abort(); subscriptions.delete(client); } };
}

/** One authenticated live feed per owning backend; polling is a disconnected fallback. */
export function useTeamOverview(client: TeamClient, { enabled }: { enabled: boolean }) {
  const cache = useQueryClient();
  const [connection, setConnection] = useState<{ client: TeamClient; connected: boolean } | null>(null);
  const connected = enabled && connection?.client === client && connection.connected;
  const query = useQuery({ queryKey: ["team-workspace-presence", client.backendId], enabled, queryFn: ({ signal }) => client.overview(signal), refetchInterval: connected ? false : 15000, retry: false });
  useEffect(() => {
    if (!enabled) return;
    return observe(client, {
      overview: value => cache.setQueryData(["team-workspace-presence", client.backendId], value),
      connection: value => setConnection({ client, connected: value }),
      changed: change => {
        const all = "all" in change;
        if (all || change.kind === "report") {
          void cache.invalidateQueries({ queryKey: ["engagements", client.backendId] });
          void cache.invalidateQueries({ queryKey: all ? ["engagement-report", client.backendId] : ["engagement-report", client.backendId, change.id] });
        }
        if (all || change.kind === "workflow") {
          for (const prefix of ["workflow-definitions", "workflow-versions", "workflow-executions"]) void cache.invalidateQueries({ queryKey: [prefix] });
        }
        if (all || change.kind === "conversation") {
          void cache.invalidateQueries({ queryKey: ["console-sessions"] });
          void cache.invalidateQueries({ queryKey: ["console-saved"] });
        }
      },
    });
  }, [client, enabled, cache]);
  return { ...query, connected };
}
