import { queryKeys } from "@/queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { toast } from "@/ui/components/toast";
import { errorText } from "@/lib/api-error";
import type { DashboardResponse, FindingFamilyResponse, FindingWorkflowPhase, FindingWorkflowStatus, FindingWorkflowSummary } from "@/types";

export type WorkflowMutationInput = {
  fingerprint: string;
  workflowStatus: FindingWorkflowStatus;
  workflowAssignee: string;
  optimisticStatus?: FindingWorkflowStatus;
};
export type TriageInput = { fingerprint: string; triageStatus: "new" | "accepted" | "suppressed"; triageNote: string };

function workflowPhaseFromStatus(status: FindingWorkflowStatus): FindingWorkflowPhase {
  if (status === "done" || status === "cancelled" || status === "blocked" || status === "in_progress" || status === "todo") return status;
  return "backlog";
}

export function patchWorkflowSummary(workflow: FindingWorkflowSummary, variables: WorkflowMutationInput): FindingWorkflowSummary {
  const closed = variables.workflowStatus === "done" || variables.workflowStatus === "cancelled";
  return {
    ...workflow,
    status: variables.optimisticStatus ?? (closed ? variables.workflowStatus : workflow.status),
    persistedStatus: variables.workflowStatus,
    recommendedStatus: closed ? variables.workflowStatus : workflow.recommendedStatus,
    phase: workflowPhaseFromStatus(variables.workflowStatus),
    assignee: variables.workflowAssignee.trim() || null,
    updatedAt: new Date().toISOString(),
  };
}

/** The API ties triage to the status it is set to: Done reads as accepted, Cancelled as dismissed, anything else reopens it. */
export function triageForWorkflow(status: FindingWorkflowStatus): TriageInput["triageStatus"] {
  return status === "done" ? "accepted" : status === "cancelled" ? "suppressed" : "new";
}

function patchLatest<T extends { workflowStatus?: FindingWorkflowStatus; workflowAssignee?: string | null; workflowUpdatedAt?: string | null; triageStatus?: string }>(latest: T, variables: WorkflowMutationInput): T {
  return { ...latest, triageStatus: triageForWorkflow(variables.workflowStatus), workflowStatus: variables.workflowStatus, workflowAssignee: variables.workflowAssignee.trim() || null, workflowUpdatedAt: new Date().toISOString() };
}

export function patchDashboardWorkflow(dashboard: DashboardResponse, variables: WorkflowMutationInput): DashboardResponse {
  return {
    ...dashboard,
    groups: dashboard.groups.map(group => group.fingerprint !== variables.fingerprint ? group : { ...group, latest: patchLatest(group.latest, variables), workflow: patchWorkflowSummary(group.workflow, variables) }),
  };
}

export function patchFindingFamilyWorkflow(family: FindingFamilyResponse, variables: WorkflowMutationInput): FindingFamilyResponse {
  if (family.fingerprint !== variables.fingerprint) return family;
  return { ...family, latest: patchLatest(family.latest, variables), workflow: patchWorkflowSummary(family.workflow, variables) };
}

/** Optimistic review decision: only the latest row's triage status changes, as the API does. */
export function patchDashboardTriage(dashboard: DashboardResponse, input: TriageInput): DashboardResponse {
  return { ...dashboard, groups: dashboard.groups.map(group => group.fingerprint !== input.fingerprint ? group : { ...group, latest: { ...group.latest, triageStatus: input.triageStatus, triageNote: input.triageNote } }) };
}

/** Workflow (status/assignee) and triage (accept/dismiss/undo) writes shared by the list, board, panel and bulk bar. */
export function useFindingMutations() {
  const { client, updateFindingFamilyTriage, updateFindingFamilyWorkflow } = useBackendApi();
  const queryClient = useQueryClient();
  const dashboardKey = queryKeys.dashboard(client.backendId);

  const triage = useMutation({
    mutationFn: ({ fingerprint, triageStatus, triageNote }: TriageInput) => updateFindingFamilyTriage(fingerprint, triageStatus, triageNote),
    onMutate: async variables => {
      await queryClient.cancelQueries({ queryKey: dashboardKey });
      const previousDashboard = queryClient.getQueryData<DashboardResponse>(dashboardKey);
      queryClient.setQueryData<DashboardResponse>(dashboardKey, current => current ? patchDashboardTriage(current, variables) : current);
      return { previousDashboard };
    },
    onSuccess: (_data, variables) => {
      if (variables.triageStatus === "new") return;
      const undo = () => triage.mutate({ ...variables, triageStatus: "new" });
      toast({ id: "finding-triage", kind: "success", title: variables.triageStatus === "accepted" ? "Risk accepted" : "Finding dismissed", action: { label: "Undo", onClick: undo } });
    },
    onError: (error, _variables, context) => {
      toast({ id: "finding-triage-failed", kind: "error", title: "Review not saved", description: errorText(error, "Couldn't reach this computer. Try again when it is back.") });
      if (context?.previousDashboard) queryClient.setQueryData(dashboardKey, context.previousDashboard);
    },
    onSettled: (_data, _error, variables) => {
      // Not awaited: refetches stall while offline and would keep the mutation (and its buttons) pending.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.findingFamily(client.backendId, variables.fingerprint) }),
      ]);
    },
  });

  const workflow = useMutation({
    mutationFn: ({ fingerprint, workflowStatus, workflowAssignee }: WorkflowMutationInput) => updateFindingFamilyWorkflow(fingerprint, workflowStatus, workflowAssignee),
    onMutate: async variables => {
      const familyKey = queryKeys.findingFamily(client.backendId, variables.fingerprint);
      await Promise.all([queryClient.cancelQueries({ queryKey: dashboardKey }), queryClient.cancelQueries({ queryKey: familyKey })]);
      const previousDashboard = queryClient.getQueryData<DashboardResponse>(dashboardKey);
      const previousFamily = queryClient.getQueryData<FindingFamilyResponse>(familyKey);
      queryClient.setQueryData<DashboardResponse>(dashboardKey, current => current ? patchDashboardWorkflow(current, variables) : current);
      queryClient.setQueryData<FindingFamilyResponse>(familyKey, current => current ? patchFindingFamilyWorkflow(current, variables) : current);
      return { previousDashboard, previousFamily, familyKey };
    },
    onError: (error, _variables, context) => {
      toast({ id: "finding-status-failed", kind: "error", title: "Status not changed", description: errorText(error, "Couldn't reach this computer. Try again when it is back.") });
      if (context?.previousDashboard) queryClient.setQueryData(dashboardKey, context.previousDashboard);
      if (context?.previousFamily) queryClient.setQueryData(context.familyKey, context.previousFamily);
    },
    onSettled: (_data, _error, variables) => {
      // Not awaited: refetches stall while offline and would keep the mutation (and its buttons) pending.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.findingFamily(client.backendId, variables.fingerprint) }),
      ]);
    },
  });

  return { triage, workflow };
}
