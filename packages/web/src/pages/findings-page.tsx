import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/state-panel";
import { ReportExportControl } from "@/components/report-export-control";
import { FindingDetail } from "@/components/findings/finding-detail";
import { FindingsBoard } from "@/components/findings/findings-board";
import { FindingsBulkBar } from "@/components/findings/findings-bulk-bar";
import { FindingsList } from "@/components/findings/findings-list";
import { FindingsToolbar, FindingsTopActions } from "@/components/findings/findings-toolbar";
import {
  findingCode, findingStatus, mergeView, resolveDrop, STATUS_LABEL, missionKey, stepCursor,
  type FindingFilters, type FindingPreset, type FindingStatus,
} from "@/components/findings/findings-model";
import { listMemory, useFindingsView } from "@/components/findings/use-findings-view";
import { useFindingMutations } from "@/components/findings/use-finding-mutations";
import { CopyButton } from "@/console/panel/views/evidence";
import { useBreadcrumbActions, useBreadcrumbLabel } from "@/lib/breadcrumbs";
import type { DashboardResponse, FindingGroup, FindingWorkflowStatus } from "@/types";
import { toast } from "@/ui/components/toast";

const isEditable = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element?.closest) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
};
const isInteractive = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.("button, a, [role='menuitem'], [role='checkbox']"));
const inOverlay = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.("[role='menu'], [role='dialog'], [role='listbox'][data-popup]"));
const isTyping = (event: KeyboardEvent) => event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || isEditable(event.target) || inOverlay(event.target);

const pagePath = (fingerprint: string) => `/findings/${encodeURIComponent(fingerprint)}`;

async function copyText(text: string) {
  try { await navigator.clipboard?.writeText(text); } catch { /* Clipboard may be unavailable; nothing else to do. */ }
}

export function FindingsPage({ dashboard }: { dashboard: DashboardResponse }) {
  const { fingerprint } = useParams<{ fingerprint?: string }>();
  const [searchParams] = useSearchParams();
  // Links from before findings had their own page: /findings?finding=<id>.
  const legacy = searchParams.get("finding");
  if (!fingerprint && legacy) return <Navigate to={pagePath(legacy)} replace />;
  return fingerprint ? <FindingFullPage dashboard={dashboard} fingerprint={fingerprint} /> : <FindingsWorkspace dashboard={dashboard} />;
}

/** `/findings/:fingerprint`: one finding on its own page. The top bar carries the breadcrumb, previous/next in list order, link and export. */
function FindingFullPage({ dashboard, fingerprint }: { dashboard: DashboardResponse; fingerprint: string }) {
  const navigate = useNavigate();
  const mutations = useFindingMutations();
  const { missionNames, navigable } = useFindingsView(dashboard, listMemory.search);
  const group = dashboard.groups.find(item => item.fingerprint === fingerprint) ?? null;
  const index = navigable.indexOf(fingerprint);
  const previous = index > 0 ? navigable[index - 1] : undefined;
  const next = index !== -1 && index < navigable.length - 1 ? navigable[index + 1] : undefined;
  listMemory.lastOpened = fingerprint;

  useBreadcrumbLabel(findingCode(fingerprint));
  const exportId = group?.latest.id;
  const actions = useMemo(() => (
    <>
      {index !== -1 ? <span className="mr-1 text-xs tabular-nums text-muted-foreground-2" aria-label={`Finding ${index + 1} of ${navigable.length}`}>{index + 1} / {navigable.length}</span> : null}
      <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground-1" aria-label="Previous finding" tooltip="Previous finding" disabled={!previous} onClick={() => previous && navigate(pagePath(previous), { replace: true })}><ChevronLeft /></Button>
      <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground-1" aria-label="Next finding" tooltip="Next finding" disabled={!next} onClick={() => next && navigate(pagePath(next), { replace: true })}><ChevronRight /></Button>
      <CopyButton text={`${window.location.origin}${pagePath(fingerprint)}`} label="link" />
      {exportId ? <ReportExportControl label="Export finding" path={`/api/findings/export?ids=${encodeURIComponent(exportId)}`} /> : null}
    </>
  ), [index, navigable.length, previous, next, navigate, fingerprint, exportId]);
  useBreadcrumbActions(actions);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      if (event.key === "j" && next) { event.preventDefault(); navigate(pagePath(next), { replace: true }); }
      else if (event.key === "k" && previous) { event.preventDefault(); navigate(pagePath(previous), { replace: true }); }
      else if (event.key === "Escape") { event.preventDefault(); navigate("/findings"); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, next, previous]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="finding-page">
      <FindingDetail
        key={fingerprint}
        fingerprint={fingerprint}
        group={group}
        missionName={group ? missionNames.get(missionKey(group)) : undefined}
        mutations={mutations}
      />
    </div>
  );
}

function FindingsWorkspace({ dashboard }: { dashboard: DashboardResponse }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState(listMemory.search);
  const deferredSearch = useDeferredValue(search);
  useEffect(() => { listMemory.search = search; }, [search]);
  const { view, setStored, patchView, setDisplay, groups, missionNames, presetCounts, visible, rows, navigable, categories, missions } = useFindingsView(dashboard, deferredSearch);
  const { display, preset, filters } = view;

  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(listMemory.lastOpened);
  const [bulkBusy, setBulkBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const mutations = useFindingMutations();

  const visibleSet = useMemo(() => new Set(visible.map(group => group.fingerprint)), [visible]);
  const selected = useMemo(() => new Set([...selection].filter(id => visibleSet.has(id))), [selection, visibleSet]);
  const selectedGroups = useMemo(() => visible.filter(group => selected.has(group.fingerprint)), [visible, selected]);

  const exportPath = useCallback((items: readonly FindingGroup[]) => `/api/findings/export?ids=${encodeURIComponent(items.map(group => group.latest.id).join(","))}`, []);

  const openFinding = useCallback((next: string) => { listMemory.lastOpened = next; navigate(pagePath(next)); }, [navigate]);
  const toggleSelect = useCallback((id: string) => setSelection(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const toggleSection = useCallback((key: string, nextCollapsed: boolean) => setStored(current => { const merged = mergeView(current); return { ...merged, collapsed: { ...merged.collapsed, [key]: nextCollapsed } }; }), [setStored]);

  const addToMission = useCallback((group: FindingGroup) => navigate(`/chats?finding=${encodeURIComponent(group.latest.id)}&intent=investigate`), [navigate]);
  const moveStatus = useCallback((fp: string, target: FindingStatus) => {
    const group = groups.find(item => item.fingerprint === fp);
    if (!group) return;
    const decision = resolveDrop(findingStatus(group), target);
    if (!decision.ok) {
      if (decision.reason) toast({ id: "finding-move-refused", kind: "error", title: `Can't move to ${STATUS_LABEL[target]}`, description: decision.reason });
      return;
    }
    if (decision.kind === "triage") mutations.triage.mutate({ fingerprint: fp, triageStatus: "accepted", triageNote: group.latest.triageNote ?? "" });
    else mutations.workflow.mutate({ fingerprint: fp, workflowStatus: decision.status, workflowAssignee: group.workflow.assignee ?? "", optimisticStatus: decision.status });
  }, [groups, mutations.workflow, mutations.triage]);

  const contextActions = useMemo(() => ({
    onOpen: openFinding,
    onCopyLink: (fp: string) => void copyText(`${window.location.origin}${pagePath(fp)}`),
    onCopyId: (fp: string) => void copyText(findingCode(fp)),
    onSetStatus: moveStatus,
    onAddToMission: addToMission,
  }), [openFinding, moveStatus, addToMission]);

  const bulkStatus = async (status: FindingWorkflowStatus) => {
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

  // Keyboard: j/k move the cursor, Enter opens its page, x selects, Escape clears the selection, / searches.
  const latest = useRef({ navigable, cursor, selected });
  latest.current = { navigable, cursor, selected };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      const state = latest.current;
      if (event.key === "j" || event.key === "k") {
        const next = stepCursor(state.navigable, state.cursor, event.key === "j" ? 1 : -1);
        if (next) { event.preventDefault(); setCursor(next); }
      } else if (event.key === "Enter" && !isInteractive(event.target) && state.cursor) {
        event.preventDefault();
        openFinding(state.cursor);
      } else if (event.key === "x" && state.cursor) {
        event.preventDefault();
        toggleSelect(state.cursor);
      } else if (event.key === "/" && !isInteractive(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "Escape" && state.selected.size > 0) {
        event.preventDefault();
        setSelection(new Set());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFinding, toggleSelect]);

  const hasFilters = search.trim().length > 0 || filters.severity.length + filters.status.length + filters.category.length + filters.mission.length > 0 || preset !== "all";
  const clearAll = () => { setSearch(""); patchView({ preset: "all", filters: { ...filters, severity: [], status: [], category: [], mission: [] } }); };

  const exportVisible = exportPath(visible);
  const topActions = useMemo(() => (
    <FindingsTopActions display={display} onDisplay={setDisplay} search={search} onSearch={setSearch} exportPath={exportVisible} exportCount={visible.length} searchRef={searchRef} />
  ), [display, setDisplay, search, exportVisible, visible.length]);
  useBreadcrumbActions(topActions);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="findings-workspace" data-search-owner="findings">
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
        exportPath={exportVisible}
        exportCount={visible.length}
        searchRef={searchRef}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {groups.length === 0 ? (
          <EmptyState variant="fill" title={<>No findings yet. Start a thread with <code className="font-mono">0 threads start</code>.</>} />
        ) : visible.length === 0 ? (
          <EmptyState variant="fill" title="Nothing matches" body={hasFilters ? "No findings match the current search or filters." : "Nothing needs attention here right now."} action={hasFilters ? <Button size="sm" variant="outline" onClick={clearAll}>Clear filters</Button> : undefined} />
        ) : display.layout === "board" ? (
          <FindingsBoard
            groups={visible}
            orderBy={display.orderBy}
            direction={display.direction}
            activeFingerprint={null}
            cursorFingerprint={cursor}
            selected={selected}
            pendingFingerprint={mutations.workflow.isPending ? mutations.workflow.variables?.fingerprint ?? null : null}
            onOpen={openFinding}
            onToggleSelect={toggleSelect}
            onMove={moveStatus}
          />
        ) : (
          <FindingsList
            rows={rows}
            missionNames={missionNames}
            cursorFingerprint={cursor}
            selected={selected}
            onOpen={openFinding}
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
    </div>
  );
}
