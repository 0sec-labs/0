import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { queryKeys } from "@/queries";

/** A finding's thread shares the scan id: open it live when it is running, else its saved transcript; no link when neither exists. */
export function useMissionHrefs(): (scanId: string) => string | null {
  const { client, listConsoleSessions, listSavedConsoleSessions } = useBackendApi();
  const live = useQuery({ queryKey: queryKeys.consoleSessions(client.backendId), queryFn: ({ signal }) => listConsoleSessions(signal), staleTime: 15_000, retry: false });
  const saved = useQuery({ queryKey: queryKeys.consoleSaved(client.backendId), queryFn: ({ signal }) => listSavedConsoleSessions(signal), staleTime: 15_000, retry: false });
  const liveData = live.data;
  const savedData = saved.data;
  return useCallback((scanId: string) => {
    const liveMatch = liveData?.find(item => item.id === scanId || item.savedId === scanId);
    if (liveMatch) return `/chats/${encodeURIComponent(liveMatch.id)}`;
    const savedMatch = savedData?.find(item => item.id === scanId);
    return savedMatch ? `/chats/saved/${encodeURIComponent(savedMatch.id)}` : null;
  }, [liveData, savedData]);
}
