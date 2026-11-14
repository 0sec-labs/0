import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { findingsForChat } from "../finding-context";
import { browserPreviews } from "../browser-previews";
import { buildEvidence, evidenceArtifactCount } from "./views/evidence-model";
import { FIXES_WORKFLOWS_PATH, fixesFromWorkflows } from "./views/fixes-model";
import { selfEditApi } from "@/lib/self-edit-api";
import { visualsFromSnapshot } from "../visuals";
import { hasHarnessContent } from "./views/tools";
import type { Workflow } from "@/components/console-control/contracts";
import type { PanelAgentSummary } from "./types";
import type { PanelViewCounts } from "./view-menu-model";

/**
 * Counts for the `+` menu and fix links for the findings view, from the same query keys the views poll, so an open
 * view keeps these live. Without an open view they load once and refresh on focus; there is no extra polling here.
 */
export function usePanelData(snapshot: ConsoleSessionSnapshot | undefined, sessionId: string | undefined) {
  const { client, getDashboard, getRuns, webFetchJson } = useBackendApi();
  const backendId = client.backendId;
  const enabled = Boolean(sessionId);
  const dashboard = useQuery({ queryKey: ["chat-findings", backendId], queryFn: getDashboard, staleTime: 30_000, enabled });
  const runs = useQuery({ queryKey: ["runs", backendId], queryFn: getRuns, staleTime: 30_000, enabled });
  const fixesQuery = useQuery({
    queryKey: ["panel-fixes", backendId, sessionId], enabled, staleTime: 30_000,
    queryFn: ({ signal }) => webFetchJson<{ workflows: Workflow[] }>(FIXES_WORKFLOWS_PATH(sessionId!), { signal }),
  });
  // Feature-detect self-edit: the Preview entry only exists when the owner opted in server-side. Errors (403, offline) hide it.
  const selfEdit = useQuery({ queryKey: ["self-edit-enabled", backendId], queryFn: selfEditApi.status, staleTime: 5 * 60_000, retry: false, enabled });
  const previewEnabled = selfEdit.data?.enabled === true;
  const savedId = snapshot?.session.savedId;
  const findings = useMemo(() => (sessionId ? findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId, runs.data) : []), [dashboard.data, runs.data, sessionId, savedId]);
  const fixes = useMemo(() => fixesFromWorkflows(fixesQuery.data?.workflows, sessionId).map(entry => entry.fix), [fixesQuery.data, sessionId]);
  const captures = useMemo(() => (snapshot ? browserPreviews(snapshot).length : 0), [snapshot]);
  const visualCount = useMemo(() => (snapshot ? visualsFromSnapshot(snapshot).length : 0), [snapshot]);
  const toolCount = snapshot?.tools.length ?? 0;
  const counts = useMemo<PanelViewCounts>(() => ({
    findings: findings.length,
    evidence: evidenceArtifactCount(buildEvidence(findings)),
    fixes: fixes.length,
    browser: captures,
    visuals: visualCount,
    ...(previewEnabled ? { preview: "enabled" } : {}),
    tools: hasHarnessContent(snapshot?.harness) || toolCount ? toolCount : undefined,
  }), [findings, fixes.length, captures, visualCount, toolCount, snapshot?.harness, previewEnabled]);
  const agents = useMemo<PanelAgentSummary[]>(() => (snapshot?.workers ?? []).map(({ id, name, task, status }) => ({ id, name, task, status })), [snapshot?.workers]);
  return { counts, fixes, agents };
}
