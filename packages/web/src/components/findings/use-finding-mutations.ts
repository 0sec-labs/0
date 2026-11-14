import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
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

function patchLatest<T extends { workflowStatus?: FindingWorkflowStatus; workflowAssignee?: string | null; workflowUpdatedAt?: string | null }>(latest: T, variables: WorkflowMutationInput): T {
  return { ...latest, workflowStatus: variables.workflowStatus, workflowAssignee: variables.workflowAssignee.trim() || null, workflowUpdatedAt: new Date().toISOString() };
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

/** Workflow (status/assignee) and triage (accept/dismiss/undo) writes shared by the list, board, panel and bulk bar. */
export function useFindingMutations() {
  const { client, updateFindingFamilyTriage, updateFindingFamilyWorkflow } = useBackendApi();
  const queryClient = useQueryClient();
  const dashboardKey = ["dashboard", client.backendId] as const;

  const triage = useMutation({
    mutationFn: ({ fingerprint, triageStatus, triageNote }: TriageInput) => updateFindingFamilyTriage(fingerprint, triageStatus, triageNote),
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardKey }),
        queryClient.invalidateQueries({ queryKey: ["finding-family", client.backendId, variables.fingerprint] }),
      ]);
    },
  });

  const workflow = useMutation({
    mutationFn: ({ fingerprint, workflowStatus, workflowAssignee }: WorkflowMutationInput) => updateFindingFamilyWorkflow(fingerprint, workflowStatus, workflowAssignee),
    onMutate: async variables => {
      const familyKey = ["finding-family", client.backendId, variables.fingerprint];
      await Promise.all([queryClient.cancelQueries({ queryKey: dashboardKey }), queryClient.cancelQueries({ queryKey: familyKey })]);
      const previousDashboard = queryClient.getQueryData<DashboardResponse>(dashboardKey);
      const previousFamily = queryClient.getQueryData<FindingFamilyResponse>(familyKey);
      queryClient.setQueryData<DashboardResponse>(dashboardKey, current => current ? patchDashboardWorkflow(current, variables) : current);
      queryClient.setQueryData<FindingFamilyResponse>(familyKey, current => current ? patchFindingFamilyWorkflow(current, variables) : current);
      return { previousDashboard, previousFamily, familyKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousDashboard) queryClient.setQueryData(dashboardKey, context.previousDashboard);
      if (context?.previousFamily) queryClient.setQueryData(context.familyKey, context.previousFamily);
    },
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardKey }),
        queryClient.invalidateQueries({ queryKey: ["finding-family", client.backendId, variables.fingerprint] }),
      ]);
    },
  });

  return { triage, workflow };
}
