import { queryKeys } from "@/queries";
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import type { Workflow } from "@/components/console-control/contracts";
import { FIXES_WORKFLOWS_PATH, fixesFromWorkflows } from "@/console/panel/views/fixes-model";
import { fixPrByFindingId } from "@/console/panel/views/findings-model";

/** Missions fetched at once when every finding needs its PR (filters and the Fix ready tab). */
export const MAX_FIX_SCANS = 40;

/**
 * Finding id -> fix PR URL. There is no global fixes route: fixes live on mission (session) workflows, and a
 * finding's `scanId` is its mission. Pass only the scan ids whose PRs are needed; failures (scans that are not
 * sessions) are ignored.
 */
export function useFindingFixPrs(scanIds: readonly string[]): Map<string, string> {
  const { client, webFetchJson } = useBackendApi();
  const key = [...new Set(scanIds)].slice(0, MAX_FIX_SCANS).join("|");
  const ids = useMemo(() => (key ? key.split("|") : []), [key]);
  const results = useQueries({
    queries: ids.map(scanId => ({
      queryKey: queryKeys.findingFixes(client.backendId, scanId),
      queryFn: ({ signal }: { signal: AbortSignal }) => webFetchJson<{ workflows: Workflow[] }>(FIXES_WORKFLOWS_PATH(scanId), { signal }),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const stamp = results.map(result => result.dataUpdatedAt).join(",");
  return useMemo(() => {
    const merged = new Map<string, string>();
    results.forEach((result, index) => {
      for (const [findingId, url] of fixPrByFindingId(fixesFromWorkflows(result.data?.workflows, ids[index]).map(entry => entry.fix))) {
        if (!merged.has(findingId)) merged.set(findingId, url);
      }
    });
    return merged;
    // `stamp` captures every result change; `results` itself is a new array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, ids]);
}
