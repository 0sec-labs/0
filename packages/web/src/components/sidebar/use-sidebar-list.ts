import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import { useSentinels } from "@/sentinels/api";
import { resolveListMode, type AgentSort, type SidebarDensity, type SidebarListMode } from "@/lib/sidebar-rows";

/** Which list the sidebar shows (remembered per browser), plus whether Sentinels exist on this server. */
export function useSidebarListMode() {
  const { supported, sentinels, isLoading } = useSentinels();
  const [stored, setStored] = usePersistentState<SidebarListMode | null>(STORAGE_KEYS.sidebarListMode, null);
  const count = sentinels.filter(sentinel => sentinel.status !== "archived").length;
  return { mode: resolveListMode(stored, count, supported), setMode: setStored, supported, loading: isLoading };
}

export const useSidebarDensity = () => usePersistentState<SidebarDensity>(STORAGE_KEYS.sidebarDensity, "comfortable");
export const useAgentSort = () => usePersistentState<AgentSort>(STORAGE_KEYS.sidebarAgentSort, "recent");
