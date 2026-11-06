import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTeamAccess } from "@/components/team-access";
import type { ModelsResponse } from "@/components/console-control/contracts";
import { modelCatalogQueryOptions } from "@/lib/model-catalog-cache";

type CatalogReader = <T>(path: string, init?: RequestInit) => Promise<T>;
/** Model ownership can differ from the tool-execution host of a relayed chat. */
export function useModelCatalog({ backendId, webFetchJson, connectionIdentity, providerId, enabled = true }: { backendId: string; webFetchJson: CatalogReader; connectionIdentity?: string | null; providerId?: string; enabled?: boolean }) {
  const team = useTeamAccess();
  const workspaceId = team.user?.workspaceId;
  const userId = team.user?.userId;
  const authenticated = !team.enabled || Boolean(team.user);
  const options = useMemo(() => modelCatalogQueryOptions(
    { backendId, workspaceId, userId, connectionIdentity, providerId, teamMode: team.enabled },
    signal => webFetchJson<ModelsResponse>(`/api/console/models${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}`, { signal }),
    // Never restore a local/anonymous catalog while team authentication is pending.
    authenticated ? undefined : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  ), [backendId, workspaceId, userId, connectionIdentity, providerId, webFetchJson, authenticated, team.enabled]);
  return useQuery({ ...options, enabled: authenticated && enabled });
}
