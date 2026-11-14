import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { findingsForChat } from "../../finding-context";

/**
 * This chat's findings. Shares the `["chat-findings", backendId]` and `["runs", backendId]` query keys with
 * `ChatFindings` so several views cost one poll. react-query pauses polling while the window is hidden.
 */
export function useChatFindings(sessionId: string | undefined, savedId?: string) {
  const { client, getDashboard, getRuns } = useBackendApi();
  const enabled = sessionId !== undefined;
  const dashboard = useQuery({ queryKey: ["chat-findings", client.backendId], queryFn: getDashboard, refetchInterval: 3000, enabled });
  const runs = useQuery({ queryKey: ["runs", client.backendId], queryFn: getRuns, refetchInterval: 3000, enabled });
  const findings = sessionId ? findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId, runs.data) : [];
  return {
    findings,
    loading: enabled && (dashboard.isPending || runs.isPending),
    error: dashboard.error ? "findings" as const : undefined,
    runsError: Boolean(runs.error),
    retry: () => { void dashboard.refetch(); void runs.refetch(); },
  };
}
