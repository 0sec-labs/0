import { queryKeys } from "@/queries";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { pollInterval } from "@/lib/polling";
import { findingsForChat } from "../../finding-context";

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 20_000;

/**
 * The shared dashboard + runs queries. They poll every 3 s only while a run is in flight; otherwise a slow safety net
 * (window focus and mount refetches do the real freshness work).
 */
export function useFindingsQueries(enabled: boolean) {
  const { client, getDashboard, getRuns } = useBackendApi();
  const runs = useQuery({ queryKey: queryKeys.runs(client.backendId), queryFn: getRuns, enabled, refetchInterval: query => pollInterval(query.state.data?.some(run => run.status === "running") ?? true, ACTIVE_POLL_MS, IDLE_POLL_MS) });
  const active = runs.data?.some(run => run.status === "running") ?? true;
  const dashboard = useQuery({ queryKey: queryKeys.chatFindings(client.backendId), queryFn: getDashboard, enabled, refetchInterval: pollInterval(active, ACTIVE_POLL_MS, IDLE_POLL_MS) });
  return { dashboard, runs };
}

/**
 * This chat's findings. Shares the `["chat-findings", backendId]` and `["runs", backendId]` query keys with
 * `ChatFindings` so several views cost one poll. react-query pauses polling while the window is hidden.
 */
export function useChatFindings(sessionId: string | undefined, savedId?: string) {
  const enabled = sessionId !== undefined;
  const { dashboard, runs } = useFindingsQueries(enabled);
  const findings = sessionId ? findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId, runs.data) : [];
  return {
    findings,
    loading: enabled && (dashboard.isPending || runs.isPending),
    error: dashboard.error ? "findings" as const : undefined,
    runsError: Boolean(runs.error),
    retry: () => { void dashboard.refetch(); void runs.refetch(); },
  };
}
