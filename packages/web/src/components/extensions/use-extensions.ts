import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { queryKeys } from "@/queries";
import type { InstallPromptDto, OverviewDto } from "@/lib/extensions-model";

const ROUTE = "/api/console/extensions";
const post = (path: string, body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export type UpdatePreview = { prompt: InstallPromptDto } | { upToDate: true; revision: string };

/** The Extensions page data and every action. Nothing here changes anything until a mutation is called from an explicit click. */
export function useExtensions() {
  const { webFetchJson, client } = useBackendApi();
  const team = useTeamAccess();
  const queryClient = useQueryClient();
  const scope = [client.backendId, team.user?.workspaceId, team.user?.userId] as const;
  const overview = useQuery({ queryKey: queryKeys.extensions(...scope), queryFn: ({ signal }) => webFetchJson<OverviewDto>(ROUTE, { signal }), refetchInterval: 15_000 });
  // The Skills page lists skills of enabled extensions, so a change here refreshes it too.
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.extensions() }), queryClient.invalidateQueries({ queryKey: queryKeys.skills() })]);
  const settle = { onSuccess: () => { void refresh(); } };
  return {
    overview,
    canChange: !team.enabled || team.user?.role === "owner",
    preview: useMutation({ mutationFn: (source: string) => webFetchJson<{ prompt: InstallPromptDto }>(`${ROUTE}/preview`, post("", { source })) }),
    info: useMutation({ mutationFn: (name: string) => webFetchJson<{ prompt: InstallPromptDto }>(`${ROUTE}/info/${encodeURIComponent(name)}`) }),
    install: useMutation({ mutationFn: (v: { source: string; approvedRevision: string; enable: boolean }) => webFetchJson<{ name: string }>(`${ROUTE}/install`, post("", { ...v, confirm: true })), ...settle }),
    previewUpdate: useMutation({ mutationFn: (name: string) => webFetchJson<UpdatePreview>(`${ROUTE}/update/preview`, post("", { name })) }),
    update: useMutation({ mutationFn: (v: { name: string; approvedRevision: string }) => webFetchJson<{ name: string }>(`${ROUTE}/update`, post("", { ...v, to: v.approvedRevision, confirm: true })), ...settle }),
    enable: useMutation({ mutationFn: (v: { name: string; approve?: boolean }) => webFetchJson<{ name: string }>(`${ROUTE}/enable`, post("", v)), ...settle }),
    disable: useMutation({ mutationFn: (v: { name: string; confirm?: boolean }) => webFetchJson<{ name: string }>(`${ROUTE}/disable`, post("", v)), ...settle }),
    remove: useMutation({ mutationFn: (name: string) => webFetchJson<{ name: string }>(`${ROUTE}/remove`, post("", { name, confirm: true })), ...settle }),
  };
}
export type ExtensionsApi = ReturnType<typeof useExtensions>;
