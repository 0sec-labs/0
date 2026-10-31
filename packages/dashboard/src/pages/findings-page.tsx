import { Tooltip } from "@/components/ui/tooltip";
import { Disclosure } from "@/components/ui/disclosure";
import { AssessmentAccessMilestones } from "@/components/access-milestone";
import { FindingImpactEditor } from "@/components/finding-impact-editor";
import { getFindingPriority } from "@0/shared/dist/finding-priority.js";
import { ReportExportControl } from "@/components/report-export-control";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Copy,
  MessageSquare,
  Search,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  SlidersHorizontal,
} from "lucide-react";
import { useBackendApi } from "@/api";
import { FindingWorkflowBoard } from "@/components/finding-workflow-board";
import { InspectorPane } from "@/components/inspector-pane";
import { PageHeader, PageContent } from "@/components/page-header";
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
import { Select } from "@/components/ui/select";
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
  queueSort: "severity",
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
    activeOnly,
    viewMode,
    queueSort: storedSort,
  } = consoleState;
  const queueSort = storedSort === "newest" ? "newest" : "severity";
  const [filtersOpen, setFiltersOpen] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const severityOptions = useMemo(
    () => ["all", ...new Set(dashboard.groups.map((group) => group.latest.severity.toLowerCase()))],
    [dashboard.groups],
  );

  const filteredGroups = useMemo(() => {
    const normalized = deferredSearch.trim().toLowerCase();

    return dashboard.groups.filter((group) => {
      if (normalized && !matchesSearch(group, normalized)) return false;
      if (workflowFilter !== "all" && group.workflow.phase !== workflowFilter) return false;
      if (reviewFilter !== "all" && group.workflow.reviewGate !== reviewFilter) return false;
      if (severityFilter !== "all" && group.latest.severity.toLowerCase() !== severityFilter) return false;
      if (consensusFilter !== "all" && group.workflow.consensus !== consensusFilter) return false;
      if (activeOnly && group.workflow.activeAgentRoles.length === 0) return false;
      return true;
    });
  }, [activeOnly, consensusFilter, dashboard.groups, deferredSearch, reviewFilter, severityFilter, workflowFilter]);

  const queueGroups = useMemo(() => {
    const ranked = [...filteredGroups];
    ranked.sort((left, right) => {
      if (queueSort === "newest") return right.latest.timestamp - left.latest.timestamp;
      return severityRank(right.latest.severity) - severityRank(left.latest.severity)
        || right.latest.timestamp - left.latest.timestamp;
    });
    return ranked;
  }, [filteredGroups, queueSort]);

  const reviewGroups = useMemo(() => queueGroups.filter(group => group.workflow.reviewGate !== "none"), [queueGroups]);

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
  const filtersActive =
    search.trim().length > 0
    || workflowFilter !== "all"
    || reviewFilter !== "all"
    || severityFilter !== "all"
    || consensusFilter !== "all"
    || activeOnly;
  const activeFilterLabels = [
    workflowFilter !== "all" ? WORKFLOW_ACTIONS.find((action) => action.value === workflowFilter)?.label ?? workflowFilter : null,
    reviewFilter !== "all" ? reviewFilter.replaceAll("_", " ") : null,
    severityFilter !== "all" ? severityFilter : null,
    consensusFilter !== "all" ? consensusFilter.replaceAll("-", " ") : null,
    activeOnly ? "active agents" : null,
  ].filter(Boolean) as string[];

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

  if (selectedFingerprint) {
    return (
      <PageContent width="wide">
        <Button variant="ghost" size="sm" asChild><Link to="/findings"><ArrowLeft className="size-4" />All findings</Link></Button>
        <PageHeader
          title={familyQuery.data?.latest.title ?? selectedGroup?.latest.title ?? "Finding"}
          actions={selectedGroup ? <ReportExportControl label="Export finding" path={`/api/findings/export?ids=${encodeURIComponent(selectedGroup.latest.id)}`} /> : undefined}
        />
        {familyQuery.isLoading ? <LoadingState label="Loading finding" /> : familyQuery.error ? <ErrorState error={familyQuery.error} /> : familyQuery.data ? (
          <FindingFamilyInspector
            key={selectedFingerprint}
            data={familyQuery.data}
            selectedSummary={selectedGroup?.workflow ?? null}
            reviewMode={viewMode === "review"}
            isSaving={triageMutation.isPending || workflowMutation.isPending}
            onTriage={(triageStatus, triageNote) => triageMutation.mutate({ triageStatus, triageNote })}
          />
        ) : <EmptyState title="Finding not found" body="It may have been removed." />}
        {triageMutation.error || workflowMutation.error ? <ErrorState error={(triageMutation.error ?? workflowMutation.error)!} /> : null}
      </PageContent>
    );
  }

  return (
    <PageContent width="wide">
      <PageHeader
        eyebrow="Findings"
        title="Findings"
        summary="Review evidence, assess impact, and track remediation."
        actions={(
          <>
            <Button variant="outline" asChild><Link to="/engagements">Assessment reports</Link></Button>
            <ReportExportControl label={selectedGroup ? "Export finding" : `Export ${visibleGroups.length} finding${visibleGroups.length === 1 ? "" : "s"}`} path={selectedGroup ? `/api/findings/export?ids=${encodeURIComponent(selectedGroup.latest.id)}` : `/api/findings/export?ids=${encodeURIComponent(visibleGroups.map(group => group.latest.id).join(","))}`} disabled={!selectedGroup && visibleGroups.length === 0} />

          </>
        )}
      />

      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-panel)] border border-border p-3">
        <Tabs value={viewMode} onValueChange={(value) => setConsoleState((current) => ({ ...current, viewMode: value as ThreadViewMode }))}>
          <TabsList>
            <TabsTrigger value="inbox">All findings</TabsTrigger>
            <TabsTrigger value="review">Review</TabsTrigger>
            <TabsTrigger value="board">Board</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex flex-wrap items-center gap-2">
        {viewMode === "inbox" ? <Select aria-label="Sort findings" value={queueSort} onValueChange={value => setConsoleState(current => ({ ...current, queueSort: value as QueueSortMode }))} options={[{ value: "severity", label: "Sort: Severity" }, { value: "newest", label: "Sort: Newest" }]} /> : null}
        <div className="relative w-full sm:w-60"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search findings" type="search" autoComplete="off" data-1p-ignore data-lpignore="true" value={search} onChange={event => setConsoleState(current => ({ ...current, search: event.target.value }))} placeholder="Search findings" className="pl-9" /></div>            <Button variant="outline" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal className="size-4" />
              Filters
              {filtersActive ? <Badge variant="neutral">{activeFilterLabels.length + (search.trim() ? 1 : 0)}</Badge> : null}
            </Button>
        </div>
      </div>
      {filtersActive ? <div className="space-y-3">

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

      </div> : null}

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
            selectedFingerprint={selectedFingerprint}
            pendingFingerprint={workflowMutation.isPending ? workflowMutation.variables?.fingerprint ?? null : null}
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

    </PageContent>
  );
}

function FindingFamilyInspector({
  data,
  selectedSummary,
  reviewMode,
  onTriage,
  isSaving,
}: {
  data: FindingFamilyResponse;
  selectedSummary: FindingWorkflowSummary | null;
  reviewMode: boolean;
  onTriage: (triageStatus: "new" | "accepted" | "suppressed", triageNote: string) => void;
  isSaving: boolean;
}) {
  const [note, setNote] = useState(data.latest.triageNote ?? "");
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const activeWorkItem = data.workItems.find((item) => item.status === "in_progress") ?? null;
  const blockedWorkItem = data.workItems.find((item) => item.status === "blocked") ?? null;
  const nextQueuedWorkItem = data.workItems.find((item) => item.status === "todo" || item.status === "backlog") ?? null;
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
    setHandoffNotice(null);
  }, [data.fingerprint]);


  return (
    <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <InspectorPane
        className="order-2 min-w-0 rounded-[var(--radius-panel)] border border-border bg-muted/10 xl:col-start-2 xl:row-start-1"
        title={
          reviewMode
            ? data.workflow.reviewGate === "human_review"
              ? "Your decision"
              : "Next step"
            : "Review & priority"
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip content={data.latest.cvssVector || "Technical severity"}><span tabIndex={0} className="flex items-center gap-1 text-xs text-muted-foreground">Severity <SeverityBadge severity={data.latest.severity} />{typeof data.latest.cvssScore === "number" && Number.isFinite(data.latest.cvssScore) ? ` · CVSS ${data.latest.cvssScore}` : null}</span></Tooltip>
          <PhaseBadge value={data.workflow.phase} />
          <ReviewBadge value={data.workflow.reviewGate} />
          {data.latest.triageStatus !== "new" ? <StatusBadge value={data.latest.triageStatus} /> : null}
        </div>

        <FindingImpactEditor key={data.latest.id} finding={data.latest} />
        {findingLocation ? <div className="text-sm text-muted-foreground">{findingLocation}</div> : null}

        {blockedWorkItem || data.workflow.phase === "blocked" ? (
          <div className="rounded-[var(--radius-panel,16px)] border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm">
            <span className="font-medium text-foreground">Blocked: </span>
            <span className="text-muted-foreground">{executionDetail}</span>
          </div>
        ) : null}

        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-label="Review note" placeholder="Note (optional)"
        />

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



        <Button variant="outline" asChild className="w-full"><Link to={`/console?finding=${encodeURIComponent(data.latest.id)}&intent=${handoffIntent}`}><MessageSquare className="size-4" />{handoffTitle}</Link></Button>
        <Disclosure summary="Terminal command" className="rounded-[var(--radius-panel)] border border-border p-3 text-sm" triggerClassName="cursor-pointer text-muted-foreground">
        <div className="mt-3 space-y-2">
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
          <code className="block overflow-x-auto rounded-[var(--radius-menu,12px)] bg-background/80 px-3 py-2 font-mono text-sm text-foreground">
            {handoffCommand}
          </code>
          {handoffNotice ? <div className="text-xs leading-5 text-muted-foreground">{handoffNotice}</div> : null}
        </div>

        </Disclosure>
        <Disclosure className="rounded-[var(--radius-panel,16px)] bg-muted/30 px-4 py-3 text-sm" summary={<> Details </>} triggerClassName="cursor-pointer font-medium text-foreground">

          <div className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <SummaryMetric label="Status" value={executionHeadline} />
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


          </div>
        </Disclosure>
      </InspectorPane>

      <section className="order-1 min-w-0 xl:col-start-1 xl:row-start-1">
        <Tabs defaultValue="overview" className="gap-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="occurrences">History ({data.rows.length})</TabsTrigger>
            <TabsTrigger value="runbook">Steps</TabsTrigger>
          </TabsList>

          <TabsContent value="runbook" className="space-y-5">
            <div className="space-y-3">
              {data.workItems.length === 0 ? (
                <div className="rounded-[var(--radius-panel,16px)] bg-muted/30 px-4 py-8 text-sm text-muted-foreground">
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
                <div className="rounded-[var(--radius-panel,16px)] bg-muted/30 px-4 py-8 text-sm text-muted-foreground">
                  No files yet.
                </div>
              ) : (
                <div className="grid gap-3">
                  {data.artifacts.map((artifact) => (
                    <div key={artifact.id} className="rounded-[var(--radius-panel,16px)] bg-muted/30 px-4 py-3">
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

          <TabsContent value="overview" className="space-y-6">
            <section className="space-y-2"><h2 className="text-sm font-medium">Summary</h2><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{data.latest.description}</p></section>
            <AssessmentAccessMilestones scanId={data.latest.scanId} />
            {([
              ["Evidence", data.latest.evidenceRequest],
              ["Response", data.latest.evidenceResponse],
              ["Analysis", data.latest.evidenceAnalysis],
            ] as const).filter(([, text]) => Boolean(text?.trim())).map(([label, text]) => (
              <section key={label} className="min-w-0 space-y-3"><h2 className="text-sm font-medium">{label}</h2><pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-panel)] border border-border bg-muted/20 p-4 text-xs leading-6 text-muted-foreground">{text}</pre></section>
            ))}
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
      </section>
    </div>
  );
}

function ThreadInbox({
  groups,
  selectedFingerprint,
  pendingFingerprint,
  onSelect,
}: {
  groups: FindingGroup[];
  selectedFingerprint: string | null;
  pendingFingerprint: string | null;
  onSelect: (fingerprint: string) => void;
}) {
  const sections = [{ title: "Findings", entries: groups }];
  return (
    <div className="space-y-5">
      {groups.length === 0 ? <EmptyState title="No findings" /> : null}
      {sections.filter((section) => section.entries.length > 0).map((section) => (
        <section key={section.title} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {section.title}<span className="text-muted-foreground">{section.entries.length}</span>
          </h2>
          <CardList className="overflow-hidden rounded-[var(--radius-panel,16px)]">
            {section.entries.map((group) => (
              <ThreadListItem
                key={group.fingerprint}
                group={group}
                selected={selectedFingerprint === group.fingerprint}
                saving={pendingFingerprint === group.fingerprint}
                mode="inbox"
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
  const helperText = group.workflow.reviewReason;

  return (
    <CardListItem interactive selected={selected} className="p-0">
      <Link
        to={`/findings/${encodeURIComponent(group.fingerprint)}`}
        onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onSelect(group.fingerprint); } }}
        className="group/finding grid w-full min-w-0 gap-3 rounded-[var(--radius-control)] px-4 py-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_180px_140px] sm:gap-6"
      >
        <div className="min-w-0 space-y-2">
          <div className="flex items-start gap-2"><span className="text-sm font-medium leading-6 text-foreground">{group.latest.title}</span><ArrowUpRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/finding:opacity-100" /></div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{group.latest.category}</span><span>{group.count} occurrence{group.count === 1 ? "" : "s"}</span></div>
          {helperText ? <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{helperText}</p> : null}
        </div>
        <div className="flex flex-wrap items-start gap-2 sm:flex-col sm:justify-center">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><SeverityBadge severity={group.latest.severity} /> severity</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:justify-center">
          <PhaseBadge value={group.workflow.phase} />
          {mode === "inbox" && group.workflow.reviewGate !== "none" ? <ReviewBadge value={group.workflow.reviewGate} /> : null}
          {group.latest.triageStatus !== "new" ? <StatusBadge value={group.latest.triageStatus} /> : null}
          <span className="text-xs tabular-nums text-muted-foreground">{saving ? "Saving…" : formatTime(group.workflow.updatedAt ?? group.latest.timestamp)}</span>
        </div>
      </Link>
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
          <div key={item.id} className={`rounded-[var(--radius-panel,16px)] border border-transparent px-4 py-3 ${toneClass}`}>
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
    <div className="rounded-[var(--radius-panel,16px)] bg-muted/30 px-4 py-3">
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
    <fieldset className={`min-w-0 rounded-[var(--radius-panel,16px)] bg-muted/30 px-4 py-4 ${className ?? ""}`}>
      <legend className="float-left w-full text-sm font-medium">{label}</legend>
      <div className="clear-both flex flex-wrap gap-1.5 pt-3">{children}</div>
    </fieldset>
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
      type="button"
      aria-pressed={active}
      variant={active ? "default" : "outline"}
      size="xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
