import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { consoleSnapshotKey } from "./use-console-workspace";
import { needsWorkerDetail, withWorkerDetail, type WindowedSnapshot } from "./snapshot-window";

/**
 * Snapshots list sub-agents as summaries; selecting one loads its transcript once and merges it into the
 * cached snapshot, where incremental worker events keep it current. Full-snapshot servers never need this.
 */
export function useWorkerTranscript(snapshot: ConsoleSessionSnapshot | null | undefined, workerId: string | null | undefined): { loading: boolean; failed: boolean } {
  const { client, getConsoleWorker } = useBackendApi();
  const queryClient = useQueryClient();
  const team = useTeamAccess();
  const [failed, setFailed] = useState<string | null>(null);
  const sessionId = snapshot?.session.id;
  const needed = needsWorkerDetail(snapshot, workerId);
  useEffect(() => {
    if (!needed || !sessionId || !workerId || failed === `${sessionId}:${workerId}`) return;
    const key = consoleSnapshotKey(client.backendId, sessionId, team.user?.workspaceId, team.user?.userId);
    let cancelled = false;
    void queryClient.fetchQuery({ queryKey: ["console-worker", client.backendId, sessionId, workerId], queryFn: ({ signal }) => getConsoleWorker(sessionId, workerId, signal), staleTime: 0 })
      .then(worker => { if (!cancelled) queryClient.setQueryData<WindowedSnapshot>(key, previous => previous ? withWorkerDetail(previous, worker) : previous); })
      .catch(() => { if (!cancelled) setFailed(`${sessionId}:${workerId}`); });
    return () => { cancelled = true; };
  }, [needed, sessionId, workerId, failed, client.backendId, team.user?.workspaceId, team.user?.userId, queryClient, getConsoleWorker]);
  return { loading: needed && failed !== `${sessionId}:${workerId}`, failed: needed && failed === `${sessionId}:${workerId}` };
}
