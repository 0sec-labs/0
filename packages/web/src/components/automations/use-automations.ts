import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/engine/shared";
import { createSecurityWorkflowTemplate, securityWorkflowScopeKind } from "@0/engine/shared/security-workflow-templates";
import { parseSecurityWorkflowInput } from "@0/engine/shared/security-workflows";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import type { ProjectResponse } from "@/components/console-control/contracts";
import { automationRows, blankAutomationInput, sortAutomationRows, type ScheduleSummary } from "@/components/automations/automation-model";
import { queryKeys } from "@/queries";

export const AUTOMATION_DEFINITIONS = "/api/console/workflow-definitions";
type Definitions = { definitions: SecurityWorkflow[] };
export type AutomationOwner = { ownerSentinelId: string; runIn?: "sentinel-home" | "new-mission" };

/** The saved automations, shared by the Sentinels page and every Sentinel's Automations view. */
export function useAutomationDefinitions(refetchMs = 30_000) {
  const { client, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const key = queryKeys.workflowDefinitions(client.backendId, team.user?.workspaceId, team.user?.userId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => webFetchJson<Definitions>(AUTOMATION_DEFINITIONS, { signal }), refetchInterval: refetchMs, retry: false });
  return { key, query, definitions: query.data?.definitions ?? [] };
}

/** The current folder: automations that review code run in it unless told otherwise. */
export function useAutomationWorkspace(): string {
  const { webFetchJson } = useBackendApi();
  const project = useQuery({ queryKey: queryKeys.consoleProject(), queryFn: ({ signal }) => webFetchJson<ProjectResponse>("/api/console/project", { signal }), staleTime: 60_000, retry: false });
  return project.data?.path ?? "";
}

/** Create an automation from a template or blank, optionally owned by a Sentinel, and keep the cached list current. */
export function useCreateAutomation() {
  const { webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const { key } = useAutomationDefinitions();
  const workspace = useAutomationWorkspace();
  const post = async (input: SecurityWorkflowInput): Promise<SecurityWorkflow> => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(AUTOMATION_DEFINITIONS, { method: "POST", body: JSON.stringify(parseSecurityWorkflowInput(input)) });
    cache.setQueryData<Definitions>(key, current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
    return result.definition;
  };
  return {
    fromTemplate: (templateId: string, owner?: AutomationOwner | null) => post({ ...createSecurityWorkflowTemplate(templateId, workspace && securityWorkflowScopeKind(templateId) === "workspace" ? { target: workspace } : {}), ...(owner ?? {}) } as SecurityWorkflowInput),
    blank: (owner?: AutomationOwner | null) => post({ ...blankAutomationInput({ target: workspace }), ...(owner ?? {}) }),
  };
}

/** Every automation with its schedule, for the Sentinels page and a Sentinel's own list. */
export function useAutomationRows() {
  const { webFetchJson } = useBackendApi();
  const { definitions, query } = useAutomationDefinitions();
  const schedules = { data: undefined as { triggers: ScheduleSummary[] } | undefined };
  const rows = useMemo(() => sortAutomationRows(automationRows(definitions, schedules.data?.triggers ?? [])), [definitions, schedules.data]);
  return { rows, definitions, isLoading: query.isLoading, error: query.error };
}
