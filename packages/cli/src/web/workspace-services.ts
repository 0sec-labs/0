import { osecDB, SentinelStore } from "@0/engine/storage";
import { randomUUID } from "node:crypto";
import { homeStateDir, toShareSafeFindings } from "@0/engine/shared";
import { findingFromRow } from "../state/findings-data.js";
import { RemoteProviderRelayBroker } from "./remote-provider-relay.js";
import { ConsoleGateway } from "./console-gateway.js";
import { SkillsStore } from "./skills.js";
import { EngagementStore } from "./engagements.js";
import { WebOperatorServices } from "./operator-services.js";
import { WebWorkflowService } from "./workflows.js";
import { WorkflowEngineService } from "../workflow-engine-service.js";
import { GitHubPublicationAuth } from "./github-auth.js";
import { WebSentinelService } from "./sentinels.js";
import type { TeamAuth } from "./team-auth.js";
import type { UpdateManager } from "./update-manager.js";
import { getSettings } from "../state/settings-store.js";
import { archiveIdleSessions } from "../state/session-store.js";

/** The Sentinel runner's send: keeps the `queue` mode so a trigger firing into a busy standing thread waits its turn instead of failing with 409. */
export function sendToMission(gateway: Pick<ConsoleGateway, "send">, id: string, text: string, author?: { userId: string; displayName: string }, mode?: "queue", automated?: boolean) {
  return gateway.send(id, { text, ...(mode ? { mode } : {}) }, author, automated ? { automated: true } : undefined);
}

/** Creates a thread for a Sentinel. The Sentinel's folder is not accepted by `create`, so it is applied with `configure` straight afterwards (a first message waits for it). */
export function createMission(gateway: Pick<ConsoleGateway, "create" | "configure">, input: Record<string, unknown>): { id: string } {
  const { workspacePath, ...rest } = input;
  const session = gateway.create(rest);
  if (typeof workspacePath === "string" && workspacePath) void gateway.configure(session.id, { workspacePath }).catch(() => { /* The first message reports a folder that cannot be opened. */ });
  return session;
}

/** Opt-in idle archive that never touches a Sentinel's standing thread. */
export function archiveIdleExceptAgentThreads(days: number, dbPath: string | undefined, stateDir: string | undefined): number {
  const store = new SentinelStore(dbPath);
  try {
    const protectedIds = new Set(store.list().flatMap(agent => agent.status !== "archived" && agent.homeMissionId ? [agent.homeMissionId] : []));
    return archiveIdleSessions(days, stateDir, { protectedIds });
  } finally { store.close(); }
}

type Options = { updates?: UpdateManager; relayEpoch?: string; auth: TeamAuth; controlToken: string; engineBearer?: string; dbPath?: string; stateDir?: string; workspace?: string; allowApply?: boolean; timeCapMs: number; costCapUsd: number };
export async function createWorkspaceServices(options: Options) {
  const skills = new SkillsStore({ workspace: options.workspace ?? process.cwd(), stateDir: options.stateDir ?? homeStateDir(), team: options.auth.enabled });
  const remoteProviderRelays = new RemoteProviderRelayBroker({ epoch: options.relayEpoch ?? randomUUID() });
  const gateway = new ConsoleGateway({ allowChatGptPlan: !options.auth.enabled, remoteProviderRelays, dbPath: options.dbPath, projectPath: options.workspace,
    skillAuthoring: (author, workspaceRoot) => { const actor = author ? options.auth.lookupUser(author.userId) : null; return skills.authoring({ canWrite: !options.auth.enabled || Boolean(actor && actor.role !== "viewer"), allowHostEdits: !options.auth.enabled || actor?.role === "owner" }, options.auth.enabled ? undefined : workspaceRoot); },
    skillDiscoveryOptions: workspaceRoot => ({ ...skills.discoveryOptions(), ...(options.auth.enabled ? {} : { projectRoot: workspaceRoot }) }),
    ...(options.stateDir ? { homeDir: options.stateDir } : {}),
  });
  // Opt-in sweep (archiveIdleDays; 0 = off). Deferred so it never delays startup; failures are ignored.
  setTimeout(() => { try { archiveIdleExceptAgentThreads(getSettings().archiveIdleDays, options.dbPath, options.stateDir); } catch { /* best effort */ } }, 0).unref();
  const engagements = new EngagementStore({ workspace: options.workspace ?? process.cwd(), dbPath: options.dbPath, ...(options.stateDir ? { stateDir: options.stateDir } : {}) });
  const operator = new WebOperatorServices({ allowChatGptPlan: !options.auth.enabled, updates: options.updates });
  let workflows: WebWorkflowService | undefined;
  let engine: WorkflowEngineService | undefined;
  let github: GitHubPublicationAuth | undefined;
  let sentinels: WebSentinelService | undefined;
  const dispose = async () => {
    const actions = [() => remoteProviderRelays.dispose(),() => engine?.dispose(), () => sentinels?.dispose(), () => gateway.closeAll(), () => workflows?.dispose(), () => operator.dispose(), () => github?.dispose()];
    let failure: unknown;
    for (const action of actions) { try { await action(); } catch (cause) { failure ??= cause; } }
    if (failure) throw failure;
  };
  try {
    workflows = new WebWorkflowService({ dbPath: options.dbPath });
    const workflow = workflows;
    gateway.attachWorkflowLifecycle({ invoke: (sessionId, name, args, capabilities) => workflow.invokeLifecycle(sessionId, name, args) });
    engine = new WorkflowEngineService({ token: options.engineBearer ?? options.controlToken, workspace: options.workspace, allowApply: options.allowApply, dbPath: options.dbPath, timeCapMs: options.timeCapMs, costCapUsd: options.costCapUsd }, { gateway, workflows: workflow });
    await engine.ready;
    github = new GitHubPublicationAuth();
    sentinels = new WebSentinelService({ dbPath: options.dbPath, missions: {
      // `workspacePath` is not a create-time field of the gateway; it is applied right after, and the first send waits for it.
      create: input => createMission(gateway, input),
      send: (id, text, author, mode, automated) => sendToMission(gateway, id, text, author, mode, automated),
      pendingDecisions: id => gateway.get(id).pendingDecisions.length,
      subscribe: (id, listener) => gateway.subscribe(id, event => listener(event as unknown as { type: string })),
      cancel: id => gateway.cancel(id),
      removeQueued: (id, messageId) => gateway.removeQueued(id, messageId),
      resumeQueue: (id, messageId) => gateway.sendQueuedNow(id, messageId),
      usage: id => gateway.get(id).usage,
      exists: id => { try { gateway.get(id); return true; } catch { return false; } },
      thread: id => {
        try {
          const snapshot = gateway.get(id);
          const last = [...snapshot.messages].reverse().find(message => message.role === "assistant");
          const text = last ? last.content.map(block => block.type === "text" ? block.text : "").join(" ") : "";
          const clean = text.replace(/\s+/g, " ").trim().slice(0, 240);
          return { status: snapshot.session.status, updatedAt: snapshot.session.updatedAt, ...(clean ? { lastAssistantText: clean } : {}) };
        } catch { return undefined; }
      },
      reopen: async id => ({ id: (await gateway.resume(id)).id }),
      findings: id => {
        const db = new osecDB(options.dbPath);
        try { return toShareSafeFindings(db.getFindings(id).slice(0, 200).map(findingFromRow)); } finally { db.close(); }
      },
      suggestions: id => {
        const db = new osecDB(options.dbPath);
        try {
          return db.getFindings(id).slice(0, 200).flatMap(row => {
            const annotation = db.getFindingReviewFields(row.id).reviewAnnotation;
            return annotation?.suggestion ? [{ id: row.id, title: row.title, severity: row.severity, path: annotation.path, startLine: annotation.startLine, ...(annotation.endLine ? { endLine: annotation.endLine } : {}), suggestion: annotation.suggestion }] : [];
          });
        } finally { db.close(); }
      },
    }, scheduler: true });
    return { remoteProviderRelays, skills, gateway, engagements, operator, workflows: workflow, engine, github, sentinels, dispose };
  } catch (cause) { await dispose().catch(() => {}); throw cause; }
}
