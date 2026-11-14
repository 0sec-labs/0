import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getFindingPriority } from "@0/engine/dist/shared/finding-priority.js";
import { CapyArrowLeftIcon as ArrowLeft } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { PageContent } from "@/components/page-header";
import { FindingDetail } from "@/components/findings/finding-detail";
import { FindingsBoard } from "@/components/findings/findings-board";
import { FindingsBulkBar } from "@/components/findings/findings-bulk-bar";
import { FindingsList } from "@/components/findings/findings-list";
import { FindingsToolbar } from "@/components/findings/findings-toolbar";
import {
  PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, boardColumns, buildSections, clampPanelWidth, facetCounts, findingCode, findingStatus, flattenSections, matchesFilters,
  matchesFindingSearch, matchesPreset, mergeView, missionKey, missionLabels, navigableFingerprints, stepCursor,
  type DisplayOptions, type FindingFilters, type FindingPreset, type FindingStatus, type FindingsView,
} from "@/components/findings/findings-model";
import { useFindingFixPrs } from "@/components/findings/use-finding-fixes";
import { useFindingMutations } from "@/components/findings/use-finding-mutations";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";
import { v } from "@/lib/vocabulary";
import type { DashboardResponse, FindingGroup } from "@/types";

/** Pages render inside a padded scroll container; lists need a fixed-height region so they can window and scroll internally. */
function useFillHeight(ref: RefObject<HTMLElement | null>, bottomGap = 20) {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const update = () => {
      const top = ref.current?.getBoundingClientRect().top ?? 0;
      setHeight(Math.max(448, Math.floor(window.innerHeight - top - bottomGap)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [ref, bottomGap]);
  return height;
}

const isEditable = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element?.closest) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
};
const isInteractive = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.("button, a, [role='menuitem'], [role='checkbox']"));
const inOverlay = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.("[role='menu'], [role='dialog'], [role='listbox'][data-popup]"));

async function copyText(text: string) {
  try { await navigator.clipboard?.writeText(text); } catch { /* Clipboard may be unavailable; nothing else to do. */ }
}

export function FindingsPage({ dashboard }: { dashboard: DashboardResponse }) {
  const { fingerprint } = useParams<{ fingerprint?: string }>();
  return fingerprint ? <FindingFullPage dashboard={dashboard} fingerprint={fingerprint} /> : <FindingsWorkspace dashboard={dashboard} />;
}

/** `/findings/:fingerprint`: the same detail view as the side panel, centred on its own page. */
function FindingFullPage({ dashboard, fingerprint }: { dashboard: DashboardResponse; fingerprint: string }) {
  const mutations = useFindingMutations();
  const group = dashboard.groups.find(item => item.fingerprint === fingerprint) ?? null;
  const fixPrs = useFindingFixPrs(group ? [group.latest.scanId] : []);
  const missions = useMemo(() => missionLabels(dashboard.scans), [dashboard.scans]);
  const root = useRef<HTMLDivElement>(null);
  const height = useFillHeight(root);
  return (
    <PageContent width="wide" className="space-y-2">
      <Button variant="ghost" size="sm" asChild><Link to="/findings"><ArrowLeft className="size-4" />All findings</Link></Button>
      <div ref={root} style={{ height }} className="flex min-h-0 flex-col overflow-hidden rounded-lg border-[0.5px] border-border-1">
        <FindingDetail
          key={fingerprint}
          fingerprint={fingerprint}
          group={group}
          variant="page"
          fixPrUrl={group ? fixPrs.get(group.latest.id) : undefined}
          missionName={group ? missions.get(missionKey(group)) : undefined}
          mutations={mutations}
        />
      </div>
    </PageContent>
  );
}

function FindingsWorkspace({ dashboard }: { dashboard: DashboardResponse }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeFingerprint = searchParams.get("finding");
  const [stored, setStored] = usePersistentState<FindingsView>("0:findings:view", mergeView(undefined));
  const view = useMemo(() => mergeView(stored), [stored]);
  const { display, preset, filters, collapsed } = view;
  const patchView = useCallback((patch: Partial<FindingsView>) => setStored(current => ({ ...mergeView(current), ...patch })), [setStored]);
  const setDisplay = useCallback((patch: Partial<DisplayOptions>) => setStored(current => { const base = mergeView(current); return { ...base, display: { ...base.display, ...patch } }; }), [setStored]);

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(activeFingerprint);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const height = useFillHeight(root);
  const mutations = useFindingMutations();

  const groups = dashboard.groups;
  const missionNames = useMemo(() => missionLabels(dashboard.scans), [dashboard.scans]);
  const activeGroup = useMemo(() => groups.find(group => group.fingerprint === activeFingerprint) ?? null, [groups, activeFingerprint]);

  // PR links live on mission workflows: load them for everything only when something needs them.
  const needsAllFixes = preset === "fix-ready" || filters.hasFixPr;
  const fixScanIds = useMemo(() => needsAllFixes ? groups.map(group => group.latest.scanId) : activeGroup ? [activeGroup.latest.scanId] : [], [needsAllFixes, groups, activeGroup]);
  const fixPrs = useFindingFixPrs(fixScanIds);
  const context = useMemo(() => ({ fixPrs }), [fixPrs]);

  const searchExtra = useCallback((group: FindingGroup) => { const priority = getFindingPriority(group.latest); return `${priority.label} ${priority.rationale}`; }, []);
  const base = useMemo(
    () => groups.filter(group => matchesFindingSearch(group, deferredSearch, deferredSearch.trim() ? searchExtra(group) : "") && matchesFilters(group, filters, context)),
    [groups, deferredSearch, filters, context, searchExtra],
  );
  const presetCounts = useMemo(() => ({
    all: base.length,
    review: base.filter(group => matchesPreset(group, "review", context)).length,
    "fix-ready": base.filter(group => matchesPreset(group, "fix-ready", context)).length,
    closed: base.filter(group => matchesPreset(group, "closed", context)).length,
  }), [base, context]);
  const visible = useMemo(() => base.filter(group => matchesPreset(group, preset, context)), [base, preset, context]);

  const sections = useMemo(() => buildSections(visible, display, missionNames), [visible, display, missionNames]);
  const rows = useMemo(() => flattenSections(sections, collapsed), [sections, collapsed]);
  const navigable = useMemo(
    () => display.layout === "board" ? boardColumns(visible, display.orderBy, display.direction).flatMap(column => column.items.map(group => group.fingerprint)) : navigableFingerprints(rows),
    [display, visible, rows],
  );
  const categories = useMemo(() => facetCounts(groups, group => group.latest.category), [groups]);
  const missions = useMemo(() => facetCounts(groups, missionKey), [groups]);

  const visibleSet = useMemo(() => new Set(visible.map(group => group.fingerprint)), [visible]);
  const selected = useMemo(() => new Set([...selection].filter(id => visibleSet.has(id))), [selection, visibleSet]);
  const selectedGroups = useMemo(() => visible.filter(group => selected.has(group.fingerprint)), [visible, selected]);

  const exportPath = useCallback((items: readonly FindingGroup[]) => `/api/findings/export?ids=${encodeURIComponent(items.map(group => group.latest.id).join(","))}`, []);

  const openFinding = useCallback((next: string, replace = false) => {
    setCursor(next);
    setSearchParams(current => { const params = new URLSearchParams(current); params.set("finding", next); return params; }, { replace });
  }, [setSearchParams]);
  const closePanel = useCallback(() => {
    setSearchParams(current => { const params = new URLSearchParams(current); params.delete("finding"); return params; }, { replace: true });
  }, [setSearchParams]);
  useEffect(() => { if (activeFingerprint) setCursor(activeFingerprint); }, [activeFingerprint]);

  const toggleSelect = useCallback((id: string) => setSelection(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const toggleSection = useCallback((key: string, nextCollapsed: boolean) => setStored(current => { const merged = mergeView(current); return { ...merged, collapsed: { ...merged.collapsed, [key]: nextCollapsed } }; }), [setStored]);

  const linkFor = (fp: string) => `${window.location.origin}/findings?finding=${encodeURIComponent(fp)}`;
  const addToMission = useCallback((group: FindingGroup) => navigate(`/console?finding=${encodeURIComponent(group.latest.id)}&intent=investigate`), [navigate]);
  const moveStatus = useCallback((fp: string, status: FindingStatus) => {
    const group = groups.find(item => item.fingerprint === fp);
    if (!group || findingStatus(group) === status) return;
    mutations.workflow.mutate({ fingerprint: fp, workflowStatus: status, workflowAssignee: group.workflow.assignee ?? "", optimisticStatus: status });
  }, [groups, mutations.workflow]);

  const contextActions = useMemo(() => ({
    onOpen: (fp: string) => openFinding(fp),
    onCopyLink: (fp: string) => void copyText(linkFor(fp)),
    onCopyId: (fp: string) => void copyText(findingCode(fp)),
    onSetStatus: moveStatus,
    onAddToMission: addToMission,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [openFinding, moveStatus, addToMission]);

  const bulkStatus = async (status: FindingStatus) => {
    setBulkBusy(true);
    for (const group of selectedGroups) {
      await mutations.workflow.mutateAsync({ fingerprint: group.fingerprint, workflowStatus: status, workflowAssignee: group.workflow.assignee ?? "", optimisticStatus: status }).catch(() => undefined);
    }
    setBulkBusy(false);
  };
  const bulkDismiss = async () => {
    setBulkBusy(true);
    for (const group of selectedGroups) {
      await mutations.triage.mutateAsync({ fingerprint: group.fingerprint, triageStatus: "suppressed", triageNote: group.latest.triageNote ?? "" }).catch(() => undefined);
    }
    setBulkBusy(false);
    setSelection(new Set());
  };

  // Keyboard: j/k move and open, Enter opens, x selects, Escape clears then closes, / searches.
  const latest = useRef({ navigable, cursor, selected, activeFingerprint });
  latest.current = { navigable, cursor, selected, activeFingerprint };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (isEditable(event.target) || inOverlay(event.target)) return;
      const state = latest.current;
      if (event.key === "j" || event.key === "k") {
        const next = stepCursor(state.navigable, state.cursor, event.key === "j" ? 1 : -1);
        if (next) { event.preventDefault(); openFinding(next, Boolean(state.activeFingerprint)); }
      } else if (event.key === "Enter" && !isInteractive(event.target) && state.cursor) {
        event.preventDefault();
        openFinding(state.cursor);
      } else if (event.key === "x" && state.cursor) {
        event.preventDefault();
        toggleSelect(state.cursor);
      } else if (event.key === "/" && !isInteractive(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "Escape") {
        if (state.selected.size > 0) { event.preventDefault(); setSelection(new Set()); }
        else if (state.activeFingerprint) { event.preventDefault(); closePanel(); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFinding, closePanel, toggleSelect]);

  const index = activeFingerprint ? navigable.indexOf(activeFingerprint) : -1;
  const panelWidth = liveWidth ?? view.panelWidth;
  const hasFilters = search.trim().length > 0 || filters.severity.length + filters.status.length + filters.category.length + filters.mission.length > 0 || filters.hasFixPr || preset !== "all";
  const clearAll = () => { setSearch(""); patchView({ preset: "all", filters: { ...filters, severity: [], status: [], category: [], mission: [], hasFixPr: false } }); };

  return (
    <div ref={root} style={{ height }} className="-mx-2 flex min-h-0 min-w-0 flex-col" data-testid="findings-workspace">
      <FindingsToolbar
        total={groups.length}
        shown={visible.length}
        preset={preset}
        presetCounts={presetCounts}
        onPreset={(next: FindingPreset) => patchView({ preset: next })}
        display={display}
        onDisplay={setDisplay}
        filters={filters}
        onFilters={(next: FindingFilters) => patchView({ filters: next })}
        categories={categories}
        missions={missions}
        missionNames={missionNames}
        search={search}
        onSearch={setSearch}
        exportPath={exportPath(visible)}
        exportCount={visible.length}
        onOpenReports={() => navigate("/engagements")}
        searchRef={searchRef}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {groups.length === 0 ? (
            <Placeholder title="No findings yet" body={v("Findings from your {missions} show up here.")} action={<Button asChild size="sm" variant="accent"><Link to="/console">{v("Start {a mission}")}</Link></Button>} />
          ) : visible.length === 0 ? (
            <Placeholder title="Nothing matches" body="Try a different search or clear the filters." action={hasFilters ? <Button size="sm" variant="outline" onClick={clearAll}>Clear filters</Button> : undefined} />
          ) : display.layout === "board" ? (
            <FindingsBoard
              groups={visible}
              orderBy={display.orderBy}
              direction={display.direction}
              activeFingerprint={activeFingerprint}
              cursorFingerprint={cursor}
              selected={selected}
              pendingFingerprint={mutations.workflow.isPending ? mutations.workflow.variables?.fingerprint ?? null : null}
              fixPrs={fixPrs}
              onOpen={fp => openFinding(fp)}
              onToggleSelect={toggleSelect}
              onMove={moveStatus}
            />
          ) : (
            <FindingsList
              rows={rows}
              activeFingerprint={activeFingerprint}
              cursorFingerprint={cursor}
              selected={selected}
              fixPrs={fixPrs}
              onOpen={fp => openFinding(fp)}
              onToggleSelect={toggleSelect}
              onToggleSection={toggleSection}
              contextActions={contextActions}
            />
          )}
          {selected.size > 0 ? (
            <FindingsBulkBar
              count={selected.size}
              busy={bulkBusy}
              exportPath={exportPath(selectedGroups)}
              onStatus={status => void bulkStatus(status)}
              onDismiss={() => void bulkDismiss()}
              onAddToMission={selectedGroups.length === 1 ? () => addToMission(selectedGroups[0]!) : undefined}
              onClear={() => setSelection(new Set())}
            />
          ) : null}
        </div>
        {activeFingerprint ? (
          <aside
            aria-label="Finding details"
            style={{ "--panel-w": `${panelWidth}px` } as React.CSSProperties}
            className="ui-surface-enter fixed inset-y-0 right-0 z-40 flex w-full max-w-[min(100vw,var(--panel-w))] border-l-[0.5px] border-border-1 bg-background lg:static lg:z-auto lg:w-[var(--panel-w)] lg:max-w-[60%] lg:shrink-0 lg:bg-transparent"
          >
            <PanelResizer width={panelWidth} onLive={setLiveWidth} onCommit={width => { setLiveWidth(null); patchView({ panelWidth: width }); }} />
            <FindingDetail
              key={activeFingerprint}
              fingerprint={activeFingerprint}
              group={activeGroup}
              variant="panel"
              fixPrUrl={activeGroup ? fixPrs.get(activeGroup.latest.id) : undefined}
              missionName={activeGroup ? missionNames.get(missionKey(activeGroup)) : undefined}
              mutations={mutations}
              onClose={closePanel}
              onPrev={index > 0 ? () => openFinding(navigable[index - 1]!, true) : undefined}
              onNext={index !== -1 && index < navigable.length - 1 ? () => openFinding(navigable[index + 1]!, true) : undefined}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Placeholder({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground-1">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** 8px drag handle on the panel's left edge; arrow keys resize by 16px. */
function PanelResizer({ width, onLive, onCommit }: { width: number; onLive: (width: number) => void; onCommit: (width: number) => void }) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={PANEL_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { startX: event.clientX, startWidth: width, width }; }}
      onPointerMove={event => {
        if (!drag.current) return;
        drag.current.width = clampPanelWidth(drag.current.startWidth + (drag.current.startX - event.clientX));
        onLive(drag.current.width);
      }}
      onPointerUp={() => { if (drag.current) onCommit(drag.current.width); drag.current = null; }}
      onPointerCancel={() => { drag.current = null; onCommit(width); }}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onCommit(clampPanelWidth(width + (event.key === "ArrowLeft" ? 16 : -16)));
      }}
      className={cn("absolute inset-y-0 left-0 z-10 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none lg:block", "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-border-3 focus-visible:after:bg-ring")}
    />
  );
}
