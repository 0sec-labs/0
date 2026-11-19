import { useCallback, useMemo } from "react";
import { getFindingPriority } from "@0/engine/shared/finding-priority";
import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import type { DashboardResponse, FindingGroup } from "@/types";
import {
  boardColumns, buildSections, facetCounts, flattenSections, matchesFilters, matchesFindingSearch, matchesPreset, mergeView, missionKey, missionLabels, navigableFingerprints,
  type DisplayOptions, type FindingsView,
} from "./findings-model";

/** What the list remembers while a finding's own page is open, so Back lands on the same search, scroll position and row. */
export const listMemory: { search: string; scrollTop: number; lastOpened: string | null } = { search: "", scrollTop: 0, lastOpened: null };

const searchExtra = (group: FindingGroup) => { const priority = getFindingPriority(group.latest); return `${priority.label} ${priority.rationale}`; };

/** The persisted view (tabs, filters, grouping) and the findings it shows, in display order. Shared by the list and by a finding's page (previous/next). */
export function useFindingsView(dashboard: DashboardResponse, search: string) {
  const [stored, setStored] = usePersistentState<FindingsView>(STORAGE_KEYS.findingsView, mergeView(undefined));
  const view = useMemo(() => mergeView(stored), [stored]);
  const { display, preset, filters } = view;
  const patchView = useCallback((patch: Partial<FindingsView>) => setStored(current => ({ ...mergeView(current), ...patch })), [setStored]);
  const setDisplay = useCallback((patch: Partial<DisplayOptions>) => setStored(current => { const base = mergeView(current); return { ...base, display: { ...base.display, ...patch } }; }), [setStored]);

  const groups = dashboard.groups;
  const missionNames = useMemo(() => missionLabels(dashboard.scans), [dashboard.scans]);
  const base = useMemo(
    () => groups.filter(group => matchesFindingSearch(group, search, search.trim() ? searchExtra(group) : "") && matchesFilters(group, filters)),
    [groups, search, filters],
  );
  const presetCounts = useMemo(() => ({
    all: base.length,
    review: base.filter(group => matchesPreset(group, "review")).length,
    closed: base.filter(group => matchesPreset(group, "closed")).length,
  }), [base]);
  const visible = useMemo(() => base.filter(group => matchesPreset(group, preset)), [base, preset]);
  const sections = useMemo(() => buildSections(visible, display, missionNames), [visible, display, missionNames]);
  const rows = useMemo(() => flattenSections(sections, view.collapsed), [sections, view.collapsed]);
  const navigable = useMemo(
    () => display.layout === "board" ? boardColumns(visible, display.orderBy, display.direction).flatMap(column => column.items.map(group => group.fingerprint)) : navigableFingerprints(rows),
    [display, visible, rows],
  );
  const categories = useMemo(() => facetCounts(groups, group => group.latest.category), [groups]);
  const missions = useMemo(() => facetCounts(groups, missionKey), [groups]);
  return { view, setStored, patchView, setDisplay, groups, missionNames, presetCounts, visible, rows, navigable, categories, missions };
}
