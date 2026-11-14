// CaseGraphRepository: persistence for caseGraph.
import { and, or } from "drizzle-orm";
import type { PipelineEvent, WorkItemRecord } from "../../shared/index.js";
import { normalizeWorkflowStatus } from "../finding-helpers.js";
import { Repository } from "./base.js";

export class CaseGraphRepository extends Repository {

  buildCaseId(target: string): string {
    return `case:${encodeURIComponent(target.trim().toLowerCase())}`;
  }


  private inferCaseTargetType(scan: { target: string; mode?: string | null }): "ai-app" | "package" | "repository" | "web-app" | "unknown" {
    if (scan.mode === "web") return "web-app";
    if (scan.mode === "probe" || scan.mode === "mcp") return "ai-app";
    if (scan.target.startsWith("http://") || scan.target.startsWith("https://")) return "ai-app";
    if (scan.target.startsWith("/") || scan.target.startsWith(".") || scan.target.includes("/")) return "repository";
    if (!scan.target.includes(" ")) return "package";
    return "unknown";
  }


  syncCaseForScan(scanId: string): string | null {
    const scan = this.owner.getScan(scanId);
    if (!scan) return null;
    const caseId = this.buildCaseId(scan.target);
    const status =
      scan.status === "running"
        ? "in_progress"
        : scan.status === "failed"
          ? "open"
          : "open";

    this.owner.upsertCase({
      id: caseId,
      target: scan.target,
      targetType: this.inferCaseTargetType(scan),
      latestScanId: scan.id,
      status,
    });

    return caseId;
  }


  syncFindingGraph(scanId: string, fingerprint: string): void {
    const scan = this.owner.getScan(scanId);
    if (!scan) return;
    const caseId = this.syncCaseForScan(scanId);
    if (!caseId) return;

    const rows = this.owner.getRelatedFindings(fingerprint);
    if (rows.length === 0) return;
    const latest = rows[0]!;
    const scanIds = [...new Set(rows.map((row) => row.scanId))];
    const verdicts = this.owner.listVerdicts(rows.map((row) => row.id));
    const sessions = this.owner.listSessions({ scanIds });
    const runningRoles = new Set(sessions.filter((session) => session.status === "running").map((session) => session.agentRole));
    const completedRoles = new Set(sessions.filter((session) => session.status === "completed").map((session) => session.agentRole));
    const failedRoles = new Set(sessions.filter((session) => session.status === "failed").map((session) => session.agentRole));
    const hasAnalysis = Boolean(latest.evidenceAnalysis?.trim());
    const hasExploitArtifacts = Boolean(latest.evidenceRequest?.trim() || latest.evidenceResponse?.trim());
    const hasVerifierVotes = verdicts.length > 0;
    const workflowStatus = normalizeWorkflowStatus(latest.workflowStatus, latest);
    const phase =
      workflowStatus === "done" || workflowStatus === "cancelled" || workflowStatus === "blocked"
        ? workflowStatus
        : workflowStatus === "in_progress"
          ? "in_progress"
          : workflowStatus === "todo"
            ? "todo"
            : "backlog";
    const reviewGate =
      workflowStatus === "agent_review" || workflowStatus === "human_review"
        ? workflowStatus
        : latest.status === "verified" || latest.status === "confirmed" || latest.status === "scored" || latest.status === "reported" || latest.status === "fixed" || latest.status === "false-positive"
          ? "human_review"
          : "none";

    const surfaceMapStatus: WorkItemRecord["status"] =
      failedRoles.has("discovery")
        ? "blocked"
        : runningRoles.has("discovery")
          ? "in_progress"
          : completedRoles.has("discovery") || scan.status !== "running" || rows.length > 0
            ? "done"
            : "todo";

    const hypothesisStatus: WorkItemRecord["status"] =
      failedRoles.has("review") || failedRoles.has("audit")
        ? "blocked"
        : runningRoles.has("review") || runningRoles.has("audit")
          ? "in_progress"
          : hasAnalysis || completedRoles.has("review") || completedRoles.has("audit")
            ? "done"
            : surfaceMapStatus === "done"
              ? "todo"
              : "backlog";

    const pocBuildStatus: WorkItemRecord["status"] =
      failedRoles.has("attack")
        ? "blocked"
        : runningRoles.has("attack")
          ? "in_progress"
          : hasExploitArtifacts || completedRoles.has("attack")
            ? "done"
            : hypothesisStatus === "done"
              ? "todo"
              : "backlog";

    const blindVerifyStatus: WorkItemRecord["status"] =
      failedRoles.has("verify")
        ? "blocked"
        : runningRoles.has("verify")
          ? "in_progress"
          : hasVerifierVotes || ["verified", "confirmed", "scored", "reported", "fixed", "false-positive"].includes(latest.status)
            ? "done"
            : pocBuildStatus === "done"
              ? "todo"
              : "backlog";

    const consensusStatus: WorkItemRecord["status"] =
      workflowStatus === "done" || workflowStatus === "cancelled" || ["verified", "confirmed", "scored", "reported", "fixed", "false-positive"].includes(latest.status)
        ? "done"
        : reviewGate === "agent_review"
          ? hasVerifierVotes
            ? "todo"
            : blindVerifyStatus === "in_progress"
              ? "backlog"
              : "todo"
          : blindVerifyStatus === "done"
            ? "todo"
            : "backlog";

    const humanReviewStatus: WorkItemRecord["status"] =
      phase === "done" || phase === "cancelled"
        ? "done"
        : reviewGate === "human_review"
          ? "todo"
          : reviewGate === "agent_review"
            ? "blocked"
            : consensusStatus === "done"
              ? "todo"
              : "backlog";

    const items: Array<{
      kind: WorkItemRecord["kind"];
      title: string;
      owner: string | null;
      status: WorkItemRecord["status"];
      summary: string;
      dependsOn?: string | null;
    }> = [
      {
        kind: "surface_map",
        title: "Attack surface mapping",
        owner: "attack-surface-agent",
        status: surfaceMapStatus,
        summary: "Initial target surface and candidate family context captured.",
        dependsOn: null,
      },
      {
        kind: "hypothesis",
        title: "Exploit hypothesis",
        owner: "research-agent",
        status: hypothesisStatus,
        summary: "Research context and exploit framing for this family.",
        dependsOn: `${fingerprint}:surface_map`,
      },
      {
        kind: "poc_build",
        title: "PoC build",
        owner: latest.workflowAssignee ?? null,
        status: pocBuildStatus,
        summary: "Exploit request/response artifacts and reproduction chain.",
        dependsOn: `${fingerprint}:hypothesis`,
      },
      {
        kind: "blind_verify",
        title: "Blind verify",
        owner: null,
        status: blindVerifyStatus,
        summary: "Independent verification pass without research reasoning.",
        dependsOn: `${fingerprint}:poc_build`,
      },
      {
        kind: "consensus",
        title: "Consensus",
        owner: "consensus-agent",
        status: consensusStatus,
        summary: "Resolve verifier evidence into a concrete next step.",
        dependsOn: `${fingerprint}:blind_verify`,
      },
      {
        kind: "human_review",
        title: "Human review",
        owner: "operator",
        status: humanReviewStatus,
        summary: "Final operator sign-off before closure, suppression, or reporting.",
        dependsOn: `${fingerprint}:consensus`,
      },
    ];

    for (const item of items) {
      this.owner.upsertWorkItem({
        id: `${fingerprint}:${item.kind}`,
        caseId,
        findingFingerprint: fingerprint,
        kind: item.kind,
        title: item.title,
        owner: item.owner,
        status: item.status,
        summary: item.summary,
        dependsOn: item.dependsOn ?? null,
      });
    }

    this.owner.upsertArtifact({
      id: `${fingerprint}:request`,
      caseId,
      findingFingerprint: fingerprint,
      kind: "request",
      label: "Exploit request",
      content: latest.evidenceRequest,
      metadata: { findingId: latest.id, scanId: latest.scanId },
    });
    this.owner.upsertArtifact({
      id: `${fingerprint}:response`,
      caseId,
      findingFingerprint: fingerprint,
      kind: "response",
      label: "Exploit response",
      content: latest.evidenceResponse,
      metadata: { findingId: latest.id, scanId: latest.scanId },
    });
    this.owner.upsertArtifact({
      id: `${fingerprint}:analysis`,
      caseId,
      findingFingerprint: fingerprint,
      kind: "analysis",
      label: "Research analysis",
      content: latest.evidenceAnalysis ?? null,
      metadata: { findingId: latest.id, scanId: latest.scanId },
    });
  }


  private roleToWorkItemKind(role: string): WorkItemRecord["kind"] | null {
    if (role === "discovery") return "surface_map";
    if (role === "attack") return "poc_build";
    if (role === "verify") return "blind_verify";
    if (role === "review" || role === "audit") return "hypothesis";
    if (role === "report") return "human_review";
    return null;
  }


  private workItemTemplate(kind: WorkItemRecord["kind"]): {
    title: string;
    owner: string | null;
    summary: string;
    dependsOn: string | null;
  } {
    switch (kind) {
      case "surface_map":
        return {
          title: "Attack surface mapping",
          owner: "attack-surface-agent",
          summary: "Map the target and establish the initial attack surface context.",
          dependsOn: null,
        };
      case "hypothesis":
        return {
          title: "Exploit hypothesis",
          owner: "research-agent",
          summary: "Turn the surface signal into a concrete exploit theory.",
          dependsOn: "surface_map",
        };
      case "poc_build":
        return {
          title: "PoC build",
          owner: "research-agent",
          summary: "Create the exploit artifact chain and reproduction path.",
          dependsOn: "hypothesis",
        };
      case "blind_verify":
        return {
          title: "Blind verify",
          owner: "verify-agent",
          summary: "Reproduce the issue independently without research reasoning.",
          dependsOn: "poc_build",
        };
      case "consensus":
        return {
          title: "Consensus",
          owner: "consensus-agent",
          summary: "Resolve verifier evidence into the next decision.",
          dependsOn: "blind_verify",
        };
      case "human_review":
        return {
          title: "Human review",
          owner: "operator",
          summary: "Final sign-off before report, suppression, or closure.",
          dependsOn: "consensus",
        };
    }
  }


  ensureCaseWorkPlan(scanId: string): string | null {
    const caseId = this.syncCaseForScan(scanId);
    if (!caseId) return null;

    for (const kind of ["surface_map", "hypothesis", "poc_build", "blind_verify", "consensus", "human_review"] as const) {
      const template = this.workItemTemplate(kind);
      this.owner.upsertWorkItem({
        id: `${caseId}:${kind}`,
        caseId,
        kind,
        title: template.title,
        owner: template.owner,
        status: "backlog",
        summary: template.summary,
        dependsOn: template.dependsOn ? `${caseId}:${template.dependsOn}` : null,
      });
    }

    return caseId;
  }


  transitionCaseWorkItem(
    scanId: string,
    kind: WorkItemRecord["kind"],
    status: WorkItemRecord["status"],
    opts?: { summary?: string | null; owner?: string | null },
  ): void {
    this.transaction(() => {
      const caseId = this.owner.ensureCaseWorkPlan(scanId);
      if (!caseId) return;
      const template = this.workItemTemplate(kind);
      const finding = this.owner.getLatestFindingForScan(scanId);
      this.owner.upsertWorkItem({
        id: `${caseId}:${kind}`,
        caseId,
        kind,
        title: template.title,
        owner: opts?.owner ?? template.owner,
        status,
        summary: opts?.summary ?? template.summary,
        dependsOn: template.dependsOn ? `${caseId}:${template.dependsOn}` : null,
      });
      this.owner.logEvent({
        scanId,
        stage: kind,
        eventType: "work_item_transition",
        findingId: finding?.id ?? undefined,
        agentRole: opts?.owner ?? template.owner ?? undefined,
        payload: {
          kind,
          status,
          owner: opts?.owner ?? template.owner ?? null,
          summary: opts?.summary ?? template.summary,
          caseId,
        },
        timestamp: Date.now(),
      });
    });
  }


  syncSessionGraph(session: {
    id: string;
    scanId: string;
    agentRole: string;
    status: string;
    toolContext: Record<string, unknown>;
  }): void {
    const caseId = this.syncCaseForScan(session.scanId);
    if (!caseId) return;

    this.owner.upsertArtifact({
      id: `session:${session.id}`,
      caseId,
      kind: "sessions",
      label: `${session.agentRole} session`,
      content: JSON.stringify(session.toolContext),
      metadata: { scanId: session.scanId, agentRole: session.agentRole, status: session.status },
    });
  }


  syncEventGraph(event: Omit<PipelineEvent, "id">, eventId: string): void {
    const caseId = this.syncCaseForScan(event.scanId);
    if (!caseId) return;
    const finding = event.findingId ? this.owner.getFinding(event.findingId) : null;
    this.owner.upsertArtifact({
      id: `event:${eventId}`,
      caseId,
      findingFingerprint: finding?.fingerprint ?? null,
      kind: "events",
      label: `${event.stage}:${event.eventType}`,
      content: JSON.stringify(event.payload),
      metadata: {
        scanId: event.scanId,
        agentRole: event.agentRole ?? null,
        findingId: event.findingId ?? null,
        timestamp: event.timestamp,
      },
    });
  }
}
