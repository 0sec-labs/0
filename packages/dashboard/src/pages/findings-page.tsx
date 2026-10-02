import { FindingImpactEditor } from "@/components/finding-impact-editor";
import { getFindingPriority, compareFindingsByBusinessPriority } from "@0/shared/dist/finding-priority.js";
import { BusinessPriorityBadge } from "@/components/business-priority-badge";
import { ReportExportControl } from "@/components/report-export-control";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  MessageSquare,
  Search,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { useBackendApi } from "@/api";
import { EvidenceTabs } from "@/components/evidence-tabs";
import { FindingWorkflowBoard } from "@/components/finding-workflow-board";
import { InspectorPane } from "@/components/inspector-pane";
import { PageHeader } from "@/components/page-header";
import { useDashboardPanel } from "@/components/dashboard-panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import {
  PhaseBadge,
  ReviewBadge,
  SeverityBadge,
  StatusBadge,
} from "@/components/status-badges";
import {
  Card,
  CardContent,
  CardHeader,
  CardList,
  CardListItem,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatTime } from "@/lib/format";
import { usePersistentState } from "@/lib/use-persistent-state";
import type {
  DashboardResponse,
  FindingGroup,
  FindingConsensus,
  FindingFamilyResponse,
  FindingReviewGate,
  FindingWorkflowPhase,
  FindingWorkflowStatus,
  FindingWorkflowSummary,
} from "@/types";

const WORKFLOW_ACTIONS: Array<{
  value: FindingWorkflowPhase;
  label: string;
}> = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const CONSENSUS_OPTIONS: Array<{ value: "all" | FindingConsensus; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "verified", label: "Verified" },
  { value: "disputed", label: "Disputed" },
  { value: "false-positive", label: "False positive" },
];

type WorkflowMutationInput = {
  fingerprint: string;
  workflowStatus: FindingWorkflowStatus;
  workflowAssignee: string;
  optimisticStatus?: FindingWorkflowStatus;
};

type ThreadViewMode = "inbox" | "review" | "board";
type QueueSortMode = "business-impact" | "attention" | "newest" | "severity";
type ThreadConsoleState = {
  search: string;
  workflowFilter: "all" | FindingWorkflowPhase;
  reviewFilter: "all" | FindingReviewGate;
  severityFilter: string;
  consensusFilter: "all" | FindingConsensus;
  assigneeFilter: string;
  activeOnly: boolean;
  viewMode: ThreadViewMode;
  queueSort: QueueSortMode;
};

const DEFAULT_THREAD_CONSOLE_STATE: ThreadConsoleState = {
  search: "",
  workflowFilter: "all",
  reviewFilter: "all",
  severityFilter: "all",
  consensusFilter: "all",
  assigneeFilter: "all",
  activeOnly: false,
  viewMode: "inbox",
  queueSort: "business-impact",
};

function matchesSearch(haystack: DashboardResponse["groups"][number], normalized: string) {
  return [
    haystack.latest.title,
    getFindingPriority(haystack.latest).label,
    getFindingPriority(haystack.latest).rationale,
    haystack.latest.impactAssessment?.blast_radius ?? "",
    haystack.latest.category,
    haystack.latest.severity,
    haystack.latest.triageStatus,
    haystack.workflow.status,
    haystack.workflow.phase,
    haystack.workflow.reviewGate,
    haystack.workflow.persistedStatus,
    haystack.workflow.recommendedStatus,
    haystack.workflow.reviewReason ?? "",
    haystack.workflow.consensus,
    haystack.workflow.assignee ?? "",
    haystack.workflow.activeAgentRoles.join(" "),
    haystack.fingerprint,
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

function patchWorkflowSummary(
  workflow: FindingWorkflowSummary,
  variables: WorkflowMutationInput,
): FindingWorkflowSummary {
  const nextAssignee = variables.workflowAssignee.trim() || null;
  const nextRecommendedStatus =
    variables.workflowStatus === "done" || variables.workflowStatus === "cancelled"
      ? variables.workflowStatus
      : workflow.recommendedStatus;
  const optimisticStatus =
    variables.optimisticStatus
    ?? (variables.workflowStatus === "done" || variables.workflowStatus === "cancelled"
      ? variables.workflowStatus
      : workflow.status);
  const nextPhase = workflowPhaseFromStatus(variables.workflowStatus);

  return {
    ...workflow,
    status: optimisticStatus,
    persistedStatus: variables.workflowStatus,
    recommendedStatus: nextRecommendedStatus,
    phase: nextPhase,
    assignee: nextAssignee,
    updatedAt: new Date().toISOString(),
  };
}

function patchDashboardWorkflow(
  dashboard: DashboardResponse,
  variables: WorkflowMutationInput,
): DashboardResponse {
  return {
    ...dashboard,
    groups: dashboard.groups.map((group) => {
      if (group.fingerprint !== variables.fingerprint) return group;
      return {
        ...group,
        latest: {
          ...group.latest,
          workflowStatus: variables.workflowStatus,
          workflowAssignee: variables.workflowAssignee.trim() || null,
          workflowUpdatedAt: new Date().toISOString(),
        },
        workflow: patchWorkflowSummary(group.workflow, variables),
      };
    }),
  };
}

function patchFindingFamilyWorkflow(
  family: FindingFamilyResponse,
  variables: WorkflowMutationInput,
): FindingFamilyResponse {
  if (family.fingerprint !== variables.fingerprint) return family;

  return {
    ...family,
    latest: {
      ...family.latest,
      workflowStatus: variables.workflowStatus,
      workflowAssignee: variables.workflowAssignee.trim() || null,
      workflowUpdatedAt: new Date().toISOString(),
    },
    workflow: patchWorkflowSummary(family.workflow, variables),
  };
}

export function FindingsPage({ dashboard }: { dashboard: DashboardResponse }) {
  const { getFindingFamily, updateFindingFamilyTriage, updateFindingFamilyWorkflow } = useBackendApi();
  const { fingerprint } = useParams<{ fingerprint?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openPanel, clearPanel } = useDashboardPanel();
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);
  const [consoleState, setConsoleState] = usePersistentState<ThreadConsoleState>(
    "0:threads:console-state",
    DEFAULT_THREAD_CONSOLE_STATE,
  );
  const {
    search,
    workflowFilter,
    reviewFilter,
    severityFilter,
    consensusFilter,
    assigneeFilter,
    activeOnly,
    viewMode,
    queueSort,
  } = consoleState;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const severityOptions = useMemo(
    () => ["all", ...new Set(dashboard.groups.map((group) => group.latest.severity.toLowerCase()))],
    [dashboard.groups],
  );

  const assigneeOptions = useMemo(
    () => ["all", ...new Set(dashboard.groups.map((group) => group.workflow.assignee).filter(Boolean))] as string[],
    [dashboard.groups],
  );

  const assigneeSuggestions = useMemo(() => {
    const values = new Set<string>();
    for (const group of dashboard.groups) {
      if (group.workflow.assignee) values.add(group.workflow.assignee);
      for (const role of group.workflow.activeAgentRoles) values.add(role);
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [dashboard.groups]);

  const filteredGroups = useMemo(() => {
    const normalized = deferredSearch.trim().toLowerCase();

    return dashboard.groups.filter((group) => {
      if (normalized && !matchesSearch(group, normalized)) return false;
      if (workflowFilter !== "all" && group.workflow.phase !== workflowFilter) return false;
      if (reviewFilter !== "all" && group.workflow.reviewGate !== reviewFilter) return false;
      if (severityFilter !== "all" && group.latest.severity.toLowerCase() !== severityFilter) return false;
      if (consensusFilter !== "all" && group.workflow.consensus !== consensusFilter) return false;
      if (
        assigneeFilter !== "all"
        && (group.workflow.assignee ?? "") !== assigneeFilter
        && !group.workflow.activeAgentRoles.includes(assigneeFilter)
      ) {
        return false;
      }
      if (activeOnly && group.workflow.activeAgentRoles.length === 0) return false;
      return true;
    });
  }, [activeOnly, assigneeFilter, consensusFilter, dashboard.groups, deferredSearch, reviewFilter, severityFilter, workflowFilter]);

  const queueGroups = useMemo(() => {
    const ranked = [...filteredGroups];
    ranked.sort((left, right) => {
      if (queueSort === "business-impact") return compareFindingsByBusinessPriority(left.latest, right.latest) || right.latest.timestamp - left.latest.timestamp;
      if (queueSort === "newest") return right.latest.timestamp - left.latest.timestamp;
      if (queueSort === "severity") return severityRank(right.latest.severity) - severityRank(left.latest.severity);
      return getFindingPriority(right.latest).rank - getFindingPriority(left.latest).rank
        || attentionRank(right) - attentionRank(left)
        || right.latest.timestamp - left.latest.timestamp;
    });
    return ranked;
  }, [filteredGroups, queueSort]);

  const reviewGroups = useMemo(() => queueGroups.filter(group => group.workflow.reviewGate !== "none"), [queueGroups]);

  const readyGroups = useMemo(
    () =>
      queueGroups.filter(
        (group) =>
          group.workflow.reviewGate === "none"
          && (group.workflow.phase === "todo" || group.workflow.phase === "backlog"),
      ),
    [queueGroups],
  );

  const activeGroups = useMemo(
    () =>
      queueGroups.filter(
        (group) => group.workflow.phase === "in_progress" || group.workflow.activeAgentRoles.length > 0,
      ),
    [queueGroups],
  );

  const blockedGroups = useMemo(
    () => queueGroups.filter((group) => group.workflow.phase === "blocked"),
    [queueGroups],
  );

  const agentReviewGroups = useMemo(
    () => reviewGroups.filter((group) => group.workflow.reviewGate === "agent_review"),
    [reviewGroups],
  );

  const humanReviewGroups = useMemo(
    () => reviewGroups.filter((group) => group.workflow.reviewGate === "human_review"),
    [reviewGroups],
  );

  const visibleGroups = viewMode === "review" ? reviewGroups : queueGroups;
  const selectedFingerprint = fingerprint ?? null;

  const familyQuery = useQuery({
    queryKey: ["finding-family", selectedFingerprint],
    queryFn: () => getFindingFamily(selectedFingerprint!),
    enabled: Boolean(selectedFingerprint),
  });

  const triageMutation = useMutation({
    mutationFn: ({
      triageStatus,
      triageNote,
    }: {
      triageStatus: "new" | "accepted" | "suppressed";
      triageNote: string;
    }) => updateFindingFamilyTriage(selectedFingerprint!, triageStatus, triageNote),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["finding-family", selectedFingerprint] }),
      ]);
    },
  });

  const workflowMutation = useMutation({
    mutationFn: ({ fingerprint: familyFingerprint, workflowStatus, workflowAssignee }: WorkflowMutationInput) =>
      updateFindingFamilyWorkflow(familyFingerprint, workflowStatus, workflowAssignee),
    onMutate: async (variables) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["dashboard"] }),
        queryClient.cancelQueries({ queryKey: ["finding-family", variables.fingerprint] }),
      ]);

      const previousDashboard = queryClient.getQueryData<DashboardResponse>(["dashboard"]);
      const previousFamily = queryClient.getQueryData<FindingFamilyResponse>(["finding-family", variables.fingerprint]);

      queryClient.setQueryData<DashboardResponse>(["dashboard"], (current) =>
        current ? patchDashboardWorkflow(current, variables) : current,
      );
      queryClient.setQueryData<FindingFamilyResponse>(["finding-family", variables.fingerprint], (current) =>
        current ? patchFindingFamilyWorkflow(current, variables) : current,
      );

      return { previousDashboard, previousFamily, fingerprint: variables.fingerprint };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousDashboard) {
        queryClient.setQueryData(["dashboard"], context.previousDashboard);
      }
      if (context?.previousFamily) {
        queryClient.setQueryData(["finding-family", context.fingerprint], context.previousFamily);
      }
    },
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["finding-family", variables.fingerprint] }),
      ]);
    },
  });

  const selectedGroup = dashboard.groups.find((group) => group.fingerprint === selectedFingerprint) ?? null;
  const selectedVisible = visibleGroups.some((group) => group.fingerprint === selectedFingerprint);
  const filtersActive =
    search.trim().length > 0
    || workflowFilter !== "all"
    || reviewFilter !== "all"
    || severityFilter !== "all"
    || consensusFilter !== "all"
    || assigneeFilter !== "all"
    || activeOnly;
  const activeFilterLabels = [
    workflowFilter !== "all" ? WORKFLOW_ACTIONS.find((action) => action.value === workflowFilter)?.label ?? workflowFilter : null,
    reviewFilter !== "all" ? reviewFilter.replaceAll("_", " ") : null,
    severityFilter !== "all" ? severityFilter : null,
    consensusFilter !== "all" ? consensusFilter.replaceAll("-", " ") : null,
    assigneeFilter !== "all" ? assigneeFilter : null,
    activeOnly ? "active agents" : null,
  ].filter(Boolean) as string[];
  const resultLabel =
    viewMode === "review"
      ? `${reviewGroups.length} to review`
      : viewMode === "board"
        ? `${filteredGroups.length} findings`
        : `${queueGroups.length} in queue`;

  function clearFilters() {
    setConsoleState((current) => ({
      ...current,
      search: "",
      workflowFilter: "all",
      reviewFilter: "all",
      severityFilter: "all",
      consensusFilter: "all",
      assigneeFilter: "all",
      activeOnly: false,
    }));
  }

  useEffect(() => {
    if (selectedFingerprint !== dismissedFingerprint) {
      setDismissedFingerprint(null);
    }
  }, [dismissedFingerprint, selectedFingerprint]);

  useEffect(() => {
    if (!selectedFingerprint || selectedFingerprint === dismissedFingerprint) {
      clearPanel();
      return;
    }

    let content: React.ReactNode;
    if (familyQuery.isLoading) {
      content = <LoadingState label="Loading finding" />;
    } else if (familyQuery.error) {
      content = <ErrorState error={familyQuery.error} />;
    } else if (familyQuery.data) {
      content = (
        <FindingFamilyInspector
          data={familyQuery.data}
          assigneeSuggestions={assigneeSuggestions}
          selectedSummary={selectedGroup?.workflow ?? null}
          reviewMode={viewMode === "review"}
          isSaving={triageMutation.isPending || workflowMutation.isPending}
          onTriage={(triageStatus, triageNote) =>
            triageMutation.mutate({ triageStatus, triageNote })
          }
          onWorkflow={(familyFingerprint, workflowStatus, workflowAssignee, optimisticStatus) =>
            workflowMutation.mutate({
              fingerprint: familyFingerprint,
              workflowStatus,
              workflowAssignee,
              optimisticStatus,
            })
          }
        />
      );
    } else {
      content = (
        <EmptyState
          title="Finding not found"
          body="It may have been removed."
        />
      );
    }

    openPanel({
      title: selectedGroup?.latest.title ?? "Finding",
      description: "",
      content: <div className="p-6">{content}</div>,
      onClose: () => {
        setDismissedFingerprint(selectedFingerprint);
        navigate("/findings");
      },
    });

    return () => {
      clearPanel();
    };
  }, [
    assigneeSuggestions,
    clearPanel,
    familyQuery.data,
    familyQuery.error,
    familyQuery.isLoading,
    navigate,
    openPanel,
    selectedFingerprint,
    selectedGroup?.latest.title,
    selectedGroup?.workflow,
    dismissedFingerprint,
    triageMutation.isPending,
    workflowMutation.isPending,
    viewMode,
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Findings"
        title="Findings"
        summary=""
        actions={(
          <>
            <ReportExportControl path={selectedGroup ? `/api/findings/export?ids=${encodeURIComponent(selectedGroup.latest.id)}` : `/api/findings/export?ids=${encodeURIComponent(visibleGroups.map(group => group.latest.id).join(","))}`} disabled={!selectedGroup && visibleGroups.length === 0} />
            <Button variant="outline" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal className="size-4" />
              Filters
              {filtersActive ? <Badge variant="neutral">{activeFilterLabels.length + (search.trim() ? 1 : 0)}</Badge> : null}
            </Button>
            {selectedFingerprint ? (
              <Button variant="outline" onClick={() => navigate("/findings")}>
                Close finding
              </Button>
            ) : null}
          </>
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <Tabs value={viewMode} onValueChange={(value) => setConsoleState((current) => ({ ...current, viewMode: value as ThreadViewMode }))}>
          <TabsList>
            <TabsTrigger value="inbox">Queue</TabsTrigger>
            <TabsTrigger value="review">Review</TabsTrigger>
            <TabsTrigger value="board">Board</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-72"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search findings" type="search" autoComplete="off" data-1p-ignore data-lpignore="true" value={search} onChange={event => setConsoleState(current => ({ ...current, search: event.target.value }))} placeholder="Search findings" className="pl-9" /></div>
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{resultLabel}</span>{selectedFingerprint && !selectedVisible ? <Badge variant="warning">Open finding is filtered out</Badge> : null}</div>

          {filtersActive || search.trim() ? (
            <div className="flex flex-wrap items-center gap-2">
              {search.trim() ? <Badge variant="outline">"{search.trim()}"</Badge> : null}
              {activeFilterLabels.map((label) => (
                <Badge key={label} variant="outline">
                  {label}
                </Badge>
              ))}
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : null}

      </div>

      <div className="min-w-0 space-y-4">
        {viewMode === "board" ? (
          <FindingWorkflowBoard
            groups={queueGroups}
            selectedFingerprint={selectedFingerprint}
            pendingFingerprint={workflowMutation.isPending ? workflowMutation.variables?.fingerprint ?? null : null}
            onSelect={(nextFingerprint) => navigate(`/findings/${nextFingerprint}`)}
            onMove={(nextFingerprint, workflowStatus) => {
              if (selectedFingerprint !== nextFingerprint) {
                navigate(`/findings/${nextFingerprint}`);
              }

              workflowMutation.mutate({
                fingerprint: nextFingerprint,
                workflowStatus,
                workflowAssignee:
                  dashboard.groups.find((group) => group.fingerprint === nextFingerprint)?.workflow.assignee ?? "",
                optimisticStatus: workflowStatus,
              });
            }}
          />
        ) : viewMode === "review" ? (
          <ThreadReviewDeck
            agentReviewGroups={agentReviewGroups}
            humanReviewGroups={humanReviewGroups}
            selectedFingerprint={selectedFingerprint}
            pendingFingerprint={workflowMutation.isPending ? workflowMutation.variables?.fingerprint ?? null : null}
            onSelect={(nextFingerprint) => navigate(`/findings/${nextFingerprint}`)}
          />
        ) : (
          <ThreadInbox
            groups={queueGroups}
            readyGroups={readyGroups}
            activeGroups={activeGroups}
            blockedGroups={blockedGroups}
            selectedFingerprint={selectedFingerprint}
            queueSort={queueSort}
            pendingFingerprint={workflowMutation.isPending ? workflowMutation.variables?.fingerprint ?? null : null}
            onSortChange={(value) => setConsoleState((current) => ({ ...current, queueSort: value }))}
            onSelect={(nextFingerprint) => navigate(`/findings/${nextFingerprint}`)}
          />
        )}
      </div>

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader className="border-b border-border pr-12">
            <SheetTitle>Filters</SheetTitle>
          </SheetHeader>

          <div className="space-y-5 p-6">


            <div className="grid gap-4 md:grid-cols-2">
              <FilterRow label="Status">
                <FilterChip active={workflowFilter === "all"} onClick={() => setConsoleState((current) => ({ ...current, workflowFilter: "all" }))}>
                  All
                </FilterChip>
                {WORKFLOW_ACTIONS.map((action) => (
                  <FilterChip
                    key={action.value}
                    active={workflowFilter === action.value}
                    onClick={() => setConsoleState((current) => ({ ...current, workflowFilter: action.value }))}
                  >
                    {action.label}
                  </FilterChip>
                ))}
              </FilterRow>

              <FilterRow label="Review">
                <FilterChip active={reviewFilter === "all"} onClick={() => setConsoleState((current) => ({ ...current, reviewFilter: "all" }))}>
                  All
                </FilterChip>
                <FilterChip active={reviewFilter === "agent_review"} onClick={() => setConsoleState((current) => ({ ...current, reviewFilter: "agent_review" }))}>
                  Agent review
                </FilterChip>
                <FilterChip active={reviewFilter === "human_review"} onClick={() => setConsoleState((current) => ({ ...current, reviewFilter: "human_review" }))}>
                  Human review
                </FilterChip>
              </FilterRow>

              <FilterRow label="Severity">
                {severityOptions.map((option) => (
                  <FilterChip
                    key={option}
                    active={severityFilter === option}
                    onClick={() => setConsoleState((current) => ({ ...current, severityFilter: option }))}
                  >
                    {option === "all" ? "All" : option[0]?.toUpperCase() + option.slice(1)}
                  </FilterChip>
                ))}
              </FilterRow>

              <FilterRow label="Verdict">
                {CONSENSUS_OPTIONS.map((option) => (
                  <FilterChip
                    key={option.value}
                    active={consensusFilter === option.value}
                    onClick={() => setConsoleState((current) => ({ ...current, consensusFilter: option.value }))}
                  >
                    {option.label}
                  </FilterChip>
                ))}
              </FilterRow>

              <FilterRow label="Owner" className="md:col-span-2">
                <FilterChip active={assigneeFilter === "all"} onClick={() => setConsoleState((current) => ({ ...current, assigneeFilter: "all" }))}>
                  Anyone
                </FilterChip>
                {assigneeOptions
                  .filter((option) => option !== "all")
                  .map((option) => (
                    <FilterChip
                      key={option}
                      active={assigneeFilter === option}
                      onClick={() => setConsoleState((current) => ({ ...current, assigneeFilter: option }))}
                    >
                      {option}
                    </FilterChip>
                  ))}
                <FilterChip active={activeOnly} onClick={() => setConsoleState((current) => ({ ...current, activeOnly: !current.activeOnly }))}>
                  Running only
                </FilterChip>
              </FilterRow>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <div className="text-sm text-muted-foreground">
                {visibleGroups.length} of {dashboard.groups.length} shown
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Reset
                </Button>
                <Button size="sm" onClick={() => setFiltersOpen(false)}>
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

    </div>
  );
}

function FindingFamilyInspector({
  data,
  assigneeSuggestions,
  selectedSummary,
  reviewMode,
  onTriage,
  onWorkflow,
  isSaving,
}: {
  data: FindingFamilyResponse;
  assigneeSuggestions: string[];
  selectedSummary: FindingWorkflowSummary | null;
  reviewMode: boolean;
  onTriage: (triageStatus: "new" | "accepted" | "suppressed", triageNote: string) => void;
  onWorkflow: (fingerprint: string, workflowStatus: FindingWorkflowPhase, workflowAssignee: string, optimisticStatus?: FindingWorkflowStatus) => void;
  isSaving: boolean;
}) {
  const [note, setNote] = useState(data.latest.triageNote ?? "");
  const [assignee, setAssignee] = useState(data.workflow.assignee ?? "");
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const datalistId = `assignee-suggestions-${data.fingerprint}`;
  const operatorSuggestions = useMemo(() => {
    const values = new Set<string>();
    if (data.workflow.assignee) values.add(data.workflow.assignee);
    for (const role of data.workflow.activeAgentRoles) values.add(role);
    for (const suggestion of assigneeSuggestions) values.add(suggestion);
    return [...values].slice(0, 8);
  }, [assigneeSuggestions, data.workflow.activeAgentRoles, data.workflow.assignee]);
  const activeWorkItem = data.workItems.find((item) => item.status === "in_progress") ?? null;
  const blockedWorkItem = data.workItems.find((item) => item.status === "blocked") ?? null;
  const nextQueuedWorkItem = data.workItems.find((item) => item.status === "todo" || item.status === "backlog") ?? null;
  const liveOwner =
    activeWorkItem?.owner
    ?? data.workflow.assignee
    ?? data.workflow.activeAgentRoles[0]
    ?? blockedWorkItem?.owner
    ?? "Unassigned";
  const executionHeadline = blockedWorkItem
    ? "Blocked"
    : activeWorkItem
      ? "Running"
      : nextQueuedWorkItem
        ? "Queued"
        : data.workflow.reviewGate !== "none"
          ? "Waiting for review"
          : "Idle";
  const executionDetail = blockedWorkItem
    ? blockedWorkItem.summary || data.workflow.reviewReason || "Needs your input."
    : activeWorkItem
      ? activeWorkItem.summary || data.workflow.reviewReason || "An agent is working on it."
      : nextQueuedWorkItem
        ? nextQueuedWorkItem.summary || "Next step is ready."
        : data.workflow.reviewReason || "Nothing running.";
  const handoffIntent =
    data.case?.targetType === "repository" && data.workflow.consensus === "verified"
      ? "draft_fix"
      : data.workflow.reviewGate === "human_review"
        ? "verify"
        : "investigate";
  const handoffCommand = data.consoleCommand.replace(
    "--finding-intent investigate",
    `--finding-intent ${handoffIntent}`,
  );
  const handoffTitle =
    handoffIntent === "draft_fix"
      ? "Fix in chat"
      : handoffIntent === "verify"
        ? "Verify in chat"
        : "Investigate in chat";
  const findingLocation = [data.case?.target, data.latest.category].filter(Boolean).join(" · ");

  const copyHandoff = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(handoffCommand);
      setHandoffNotice("Copied. Paste it in a terminal.");
    } catch {
      setHandoffNotice("Couldn't copy. Select the command and copy it manually.");
    }
  };


  useEffect(() => {
    setNote(data.latest.triageNote ?? "");
  }, [data.fingerprint, data.latest.triageNote]);

  useEffect(() => {
    setAssignee(data.workflow.assignee ?? "");
  }, [data.fingerprint, data.workflow.assignee]);
  useEffect(() => {
    setHandoffNotice(null);
  }, [data.fingerprint]);


  return (
    <div className="flex flex-col gap-5">
      <InspectorPane
        className={reviewMode ? "order-2" : "order-1"}
        title={
          reviewMode
            ? data.workflow.reviewGate === "human_review"
              ? "Your decision"
              : "Next step"
            : "Actions"
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <BusinessPriorityBadge finding={data.latest} />
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title={data.latest.cvssVector || "Technical severity"}>Technical <SeverityBadge severity={data.latest.severity} />{typeof data.latest.cvssScore === "number" && Number.isFinite(data.latest.cvssScore) ? ` · CVSS ${data.latest.cvssScore}` : null}</span>
          <PhaseBadge value={data.workflow.phase} />
          <ReviewBadge value={data.workflow.reviewGate} />
          {data.latest.triageStatus !== "new" ? <StatusBadge value={data.latest.triageStatus} /> : null}
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{getFindingPriority(data.latest).rationale}</p>
        <FindingImpactEditor key={data.latest.id} finding={data.latest} />
        {findingLocation ? <div className="text-sm text-muted-foreground">{findingLocation}</div> : null}

        {blockedWorkItem || data.workflow.phase === "blocked" ? (
          <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm">
            <span className="font-medium text-foreground">Blocked: </span>
            <span className="text-muted-foreground">{executionDetail}</span>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="success"
            onClick={() => onTriage("accepted", note)}
            disabled={isSaving}
          >
            <ShieldCheck className="size-4" />
            Accept
          </Button>
          <Button
            variant="warning"
            onClick={() => onTriage("suppressed", note)}
            disabled={isSaving}
          >
            <ShieldOff className="size-4" />
            Dismiss
          </Button>
          {data.latest.triageStatus !== "new" ? (
            <Button
              variant="ghost"
              onClick={() => onTriage("new", note)}
              disabled={isSaving}
            >
              <ShieldQuestion className="size-4" />
              Undo
            </Button>
          ) : null}
        </div>

        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Note (optional)"
        />

        <div className="space-y-2 rounded-2xl bg-muted/30 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <MessageSquare className="size-4 text-primary-text" />
              {handoffTitle}
            </div>
            <Button variant="outline" size="sm" onClick={() => void copyHandoff()}>
              <Copy className="size-4" />
              Copy
            </Button>
          </div>
          <code className="block overflow-x-auto rounded-xl bg-background/80 px-3 py-2 font-mono text-sm text-foreground">
            {handoffCommand}
          </code>
          {handoffNotice ? <div className="text-xs leading-5 text-muted-foreground">{handoffNotice}</div> : null}
        </div>

        <details className="rounded-2xl bg-muted/30 px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-foreground">Details</summary>
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <SummaryMetric label="Status" value={executionHeadline} />
              <SummaryMetric label="Owner" value={liveOwner} />
              <SummaryMetric
                label="Now"
                value={activeWorkItem ? activeWorkItem.title : blockedWorkItem ? blockedWorkItem.title : "—"}
              />
              <SummaryMetric
                label="Next"
                value={nextQueuedWorkItem ? nextQueuedWorkItem.title : data.workflow.reviewGate !== "none" ? "Review" : "—"}
              />
              <SummaryMetric label="Verdict" value={`${data.workflow.consensus} · ${data.workflow.evidenceSignal} signal`} />
              <SummaryMetric
                label="Votes (real / false / unsure)"
                value={`${data.workflow.verdictCounts.truePositive} / ${data.workflow.verdictCounts.falsePositive} / ${data.workflow.verdictCounts.unsure}`}
              />
              <SummaryMetric label="Seen" value={`${data.rows.length}×`} />
              <SummaryMetric
                label="Target type"
                value={data.case ? formatCaseTargetTypeLabel(data.case.targetType) : "Unknown"}
              />
              <SummaryMetric label="ID" value={data.fingerprint} mono />
            </div>

            {data.workflow.reviewReason || (selectedSummary && selectedSummary.persistedStatus !== selectedSummary.phase) ? (
              <div className="text-sm text-muted-foreground">
                {data.workflow.reviewReason ?? ""}
                {selectedSummary && selectedSummary.persistedStatus !== selectedSummary.phase
                  ? ` You set it to ${selectedSummary.persistedStatus}.`
                  : ""}
              </div>
            ) : null}

            <div className="flex gap-2">
              <Input
                list={datalistId}
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                placeholder="Assign to a person or agent"
              />
              <datalist id={datalistId}>
                {operatorSuggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
              <Button
                variant="outline"
                onClick={() => onWorkflow(data.fingerprint, data.workflow.phase, assignee)}
                disabled={isSaving}
              >
                <UserRound className="size-4" />
                Assign
              </Button>
            </div>
          </div>
        </details>
      </InspectorPane>

      <InspectorPane
        className={reviewMode ? "order-1" : "order-2"}
        title="Evidence"
      >
        <Tabs defaultValue="evidence" className="gap-4">
          <TabsList>
            <TabsTrigger value="evidence">Evidence</TabsTrigger>
            <TabsTrigger value="occurrences">History</TabsTrigger>
            <TabsTrigger value="runbook">Steps</TabsTrigger>
          </TabsList>

          <TabsContent value="runbook" className="space-y-5">
            <div className="space-y-3">
              {data.workItems.length === 0 ? (
                <div className="rounded-2xl bg-muted/30 px-4 py-8 text-sm text-muted-foreground">
                  No steps yet.
                </div>
              ) : (
                <ExecutionGraph
                  items={data.workItems}
                  activeWorkItemId={activeWorkItem?.id ?? null}
                  blockedWorkItemId={blockedWorkItem?.id ?? null}
                />
              )}
            </div>

            <div className="space-y-3">
              {data.artifacts.length === 0 ? (
                <div className="rounded-2xl bg-muted/30 px-4 py-8 text-sm text-muted-foreground">
                  No files yet.
                </div>
              ) : (
                <div className="grid gap-3">
                  {data.artifacts.map((artifact) => (
                    <div key={artifact.id} className="rounded-2xl bg-muted/30 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">{artifact.label}</div>
                          <div className="mt-1 text-xs leading-5 text-muted-foreground">{artifact.summary}</div>
                        </div>
                        <Badge variant="outline">{formatArtifactKindLabel(artifact.kind)}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="evidence">
            <div className="space-y-3">
              <EvidenceTabs
                request={data.latest.evidenceRequest}
                response={data.latest.evidenceResponse}
                analysis={data.latest.evidenceAnalysis}
              />
            </div>
          </TabsContent>

          <TabsContent value="occurrences">
            <Card className="overflow-hidden">
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Scan</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead className="w-[8rem]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="tabular-nums text-sm text-muted-foreground">{row.scanId.slice(0, 8)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatTime(row.timestamp)}</TableCell>
                        <TableCell><StatusBadge value={row.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </InspectorPane>
    </div>
  );
}

function ThreadInbox({
  groups,
  readyGroups,
  activeGroups,
  blockedGroups,
  selectedFingerprint,
  queueSort,
  pendingFingerprint,
  onSortChange,
  onSelect,
}: {
  groups: FindingGroup[];
  readyGroups: FindingGroup[];
  activeGroups: FindingGroup[];
  blockedGroups: FindingGroup[];
  selectedFingerprint: string | null;
  queueSort: QueueSortMode;
  pendingFingerprint: string | null;
  onSortChange: (value: QueueSortMode) => void;
  onSelect: (fingerprint: string) => void;
}) {
  const sections = queueSort === "business-impact" || queueSort === "attention" ? [{ title: queueSort === "attention" ? "Needs attention" : "Business impact", entries: groups }] : [
    { title: "Ready", entries: readyGroups },
    { title: "In progress", entries: activeGroups },
    { title: "Needs input", entries: blockedGroups },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto" />
        <Button variant={queueSort === "business-impact" ? "default" : "ghost"} size="sm" onClick={() => onSortChange("business-impact")}>Business impact</Button>
        <Button variant={queueSort === "attention" ? "default" : "ghost"} size="sm" onClick={() => onSortChange("attention")}>Needs attention</Button>
        <Button variant={queueSort === "newest" ? "default" : "ghost"} size="sm" onClick={() => onSortChange("newest")}>Newest</Button>
        <Button variant={queueSort === "severity" ? "default" : "ghost"} size="sm" onClick={() => onSortChange("severity")}>Technical severity</Button>
      </div>
      {groups.length === 0 ? <EmptyState title="No findings" /> : null}
      {sections.filter((section) => section.entries.length > 0).map((section) => (
        <section key={section.title} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {section.title}<span className="text-muted-foreground">{section.entries.length}</span>
          </h2>
          <CardList className="overflow-hidden rounded-2xl">
            {section.entries.map((group) => (
              <ThreadListItem
                key={group.fingerprint}
                group={group}
                selected={selectedFingerprint === group.fingerprint}
                saving={pendingFingerprint === group.fingerprint}
                mode={section.title === "Needs input" ? "review" : "inbox"}
                onSelect={onSelect}
              />
            ))}
          </CardList>
        </section>
      ))}
    </div>
  );
}

function ThreadReviewDeck({
  agentReviewGroups,
  humanReviewGroups,
  selectedFingerprint,
  pendingFingerprint,
  onSelect,
}: {
  agentReviewGroups: FindingGroup[];
  humanReviewGroups: FindingGroup[];
  selectedFingerprint: string | null;
  pendingFingerprint: string | null;
  onSelect: (fingerprint: string) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle className="font-sans text-base font-medium">Agent review</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {agentReviewGroups.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                title="Nothing to check"
                body=""
              />
            </div>
          ) : (
            <ScrollArea className="max-h-[70vh]">
              <CardList>
                {agentReviewGroups.map((group) => (
                  <ThreadListItem
                    key={group.fingerprint}
                    group={group}
                    selected={selectedFingerprint === group.fingerprint}
                    saving={pendingFingerprint === group.fingerprint}
                    mode="review"
                    onSelect={onSelect}
                  />
                ))}
              </CardList>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle className="font-sans text-base font-medium">Your review</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {humanReviewGroups.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                title="Nothing to review"
                body=""
              />
            </div>
          ) : (
            <ScrollArea className="max-h-[70vh]">
              <CardList>
                {humanReviewGroups.map((group) => (
                  <ThreadListItem
                    key={group.fingerprint}
                    group={group}
                    selected={selectedFingerprint === group.fingerprint}
                    saving={pendingFingerprint === group.fingerprint}
                    mode="review"
                    onSelect={onSelect}
                  />
                ))}
              </CardList>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ThreadListItem({
  group,
  selected,
  saving,
  mode,
  onSelect,
}: {
  group: FindingGroup;
  selected: boolean;
  saving: boolean;
  mode: "inbox" | "review";
  onSelect: (fingerprint: string) => void;
}) {
  const helperText = group.workflow.reviewReason ?? null;

  return (
    <CardListItem interactive selected={selected} className="p-0">
      <button
        type="button"
        onClick={() => onSelect(group.fingerprint)}
        className="w-full px-4 py-4 text-left"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-semibold leading-5 text-foreground">{group.latest.title}</div>
            <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">{getFindingPriority(group.latest).rationale}</div>
            {helperText ? <div className="text-xs leading-5 text-muted-foreground">{helperText}</div> : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {mode === "inbox" ? <ReviewBadge value={group.workflow.reviewGate} /> : null}
            {group.latest.triageStatus !== "new" ? <StatusBadge value={group.latest.triageStatus} /> : null}
            <BusinessPriorityBadge finding={group.latest} />
            <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Technical severity">Technical <SeverityBadge severity={group.latest.severity} /></span>
          </div>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {saving ? "Saving..." : formatTime(group.workflow.updatedAt ?? group.latest.timestamp)}
        </div>
      </button>
    </CardListItem>
  );
}

function TaskStatusBadge({
  value,
}: {
  value: "backlog" | "todo" | "in_progress" | "blocked" | "done" | "cancelled";
}) {
  const variant =
    value === "done"
      ? "success"
      : value === "blocked" || value === "cancelled"
        ? "danger"
        : value === "in_progress"
          ? "accent"
          : value === "todo"
            ? "warning"
            : "neutral";

  return <Badge variant={variant}>{value.replaceAll("_", " ")}</Badge>;
}

function ExecutionGraph({
  items,
  activeWorkItemId,
  blockedWorkItemId,
}: {
  items: FindingFamilyResponse["workItems"];
  activeWorkItemId: string | null;
  blockedWorkItemId: string | null;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((item) => {
        const isCurrent = activeWorkItemId === item.id;
        const isBlocked = blockedWorkItemId === item.id;
        const toneClass = isBlocked
          ? "border-destructive/30 bg-destructive/5"
          : isCurrent
            ? "border-primary/30 bg-primary/5"
            : "border-border bg-card";

        return (
          <div key={item.id} className={`rounded-2xl border border-transparent px-4 py-3 ${toneClass}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium text-foreground">{item.title}</div>
                  {isCurrent ? <Badge variant="accent">Current</Badge> : null}
                  {isBlocked ? <Badge variant="danger">Blocked</Badge> : null}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.summary}</div>
              </div>
              <TaskStatusBadge value={item.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-2xl bg-muted/30 px-4 py-3">
      <div className="text-sm text-muted-foreground/70">{label}</div>
      <div className={mono ? "mt-2 truncate tabular-nums text-sm text-foreground" : "mt-2 text-sm font-medium text-foreground"}>
        {value}
      </div>
    </div>
  );
}

function formatArtifactKindLabel(kind: FindingFamilyResponse["artifacts"][number]["kind"]) {
  return kind.replaceAll("_", " ");
}

function formatCaseTargetTypeLabel(value: NonNullable<FindingFamilyResponse["case"]>["targetType"]) {
  return value.replaceAll("-", " ");
}

function severityRank(severity: string) {
  const normalized = severity.toLowerCase();
  if (normalized === "critical") return 5;
  if (normalized === "high") return 4;
  if (normalized === "medium") return 3;
  if (normalized === "low") return 2;
  return 1;
}

function attentionRank(group: FindingGroup) {
  let rank = 0;
  if (group.workflow.reviewGate === "human_review") rank += 100;
  else if (group.workflow.reviewGate === "agent_review") rank += 90;
  else if (group.workflow.phase === "blocked") rank += 80;
  else if (group.workflow.phase === "in_progress") rank += 70;
  else if (group.workflow.phase === "todo") rank += 60;
  else if (group.workflow.phase === "backlog") rank += 50;

  if (!group.workflow.assignee) rank += 15;
  if (group.workflow.consensus === "disputed") rank += 12;
  if (group.workflow.activeAgentRoles.length > 0) rank += 8;

  return rank * 1_000_000 + group.latest.timestamp + severityRank(group.latest.severity) * 1_000;
}

function workflowPhaseFromStatus(status: FindingWorkflowStatus): FindingWorkflowPhase {
  if (status === "done" || status === "cancelled" || status === "blocked" || status === "in_progress" || status === "todo") {
    return status;
  }
  return "backlog";
}

function FilterRow({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-3 rounded-2xl bg-muted/30 px-4 py-4 ${className ?? ""}`}>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
