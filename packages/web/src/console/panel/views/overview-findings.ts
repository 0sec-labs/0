import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { findingsForChat } from "../../finding-context";

/** Read-only findings for one chat. Shares query keys with ChatFindings so react-query dedupes polling. */
export function useOverviewFindings(sessionId: string | undefined, savedId: string | undefined, enabled = true) {
  const { client, getDashboard, getRuns } = useBackendApi();
  const dashboard = useQuery({ queryKey: ["chat-findings", client.backendId], queryFn: getDashboard, refetchInterval: 3000, enabled: enabled && Boolean(sessionId) });
  const runs = useQuery({ queryKey: ["runs", client.backendId], queryFn: getRuns, refetchInterval: 3000, enabled: enabled && Boolean(sessionId) });
  const groups = sessionId ? findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId, runs.data) : [];
  return { groups, loading: dashboard.isPending, error: Boolean(dashboard.error) };
}
