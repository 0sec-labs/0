import { findingsForChat } from "../../finding-context";
import { useFindingsQueries } from "./use-chat-findings";

/** Read-only findings for one chat. Shares query keys with ChatFindings so react-query dedupes polling. */
export function useOverviewFindings(sessionId: string | undefined, savedId: string | undefined, enabled = true) {
  const { dashboard, runs } = useFindingsQueries(enabled && Boolean(sessionId));
  const groups = sessionId ? findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId, runs.data) : [];
  return { groups, loading: dashboard.isPending, error: Boolean(dashboard.error) };
}
