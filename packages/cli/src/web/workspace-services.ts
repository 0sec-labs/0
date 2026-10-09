import { LlmApiRuntime } from "@0/core";
import { homeStateDir } from "@0/shared";
import { ConsoleGateway } from "./console-gateway.js";
import { SkillsStore } from "./skills.js";
import { EngagementStore } from "./engagements.js";
import { WebOperatorServices } from "./operator-services.js";
import { WebWorkflowService } from "./workflows.js";
import { WorkflowEngineService } from "../workflow-engine-service.js";
import { WorkflowTriggerService } from "./workflow-triggers.js";
import { GitHubPublicationAuth } from "./github-auth.js";
import type { TeamAuth } from "./team-auth.js";

type Options = { auth: TeamAuth; controlToken: string; engineBearer?: string; dbPath?: string; stateDir?: string; workspace?: string; scopePath?: string; target?: string; allowApply?: boolean; timeCapMs: number; costCapUsd: number };
export async function createWorkspaceServices(options: Options) {
  const skills = new SkillsStore({ workspace: options.workspace ?? process.cwd(), stateDir: options.stateDir ?? homeStateDir(), team: options.auth.enabled });
  const gateway = new ConsoleGateway({ dbPath: options.dbPath, projectPath: options.workspace,
    skillAuthoring: (author, workspaceRoot) => { const actor = author ? options.auth.lookupUser(author.userId) : null; return skills.authoring({ canWrite: !options.auth.enabled || Boolean(actor && actor.role !== "viewer"), allowHostEdits: !options.auth.enabled || actor?.role === "owner" }, options.auth.enabled ? undefined : workspaceRoot); },
    skillDiscoveryOptions: workspaceRoot => ({ ...skills.discoveryOptions(), ...(options.auth.enabled ? {} : { projectRoot: workspaceRoot }) }),
    ...(options.stateDir ? { homeDir: options.stateDir } : {}),
  });
  const engagements = new EngagementStore({ workspace: options.workspace ?? process.cwd(), dbPath: options.dbPath, ...(options.stateDir ? { stateDir: options.stateDir } : {}) });
  const operator = new WebOperatorServices({ isTurnActive: () => gateway.hasActiveTurns() });
  let workflows: WebWorkflowService | undefined;
  let engine: WorkflowEngineService | undefined;
  let triggers: WorkflowTriggerService | undefined;
  let github: GitHubPublicationAuth | undefined;
  const dispose = async () => {
    const actions = [() => engine?.dispose(), () => triggers?.dispose(), () => gateway.closeAll(), () => workflows?.dispose(), () => operator.dispose(), () => github?.dispose()];
    let failure: unknown;
    for (const action of actions) { try { await action(); } catch (cause) { failure ??= cause; } }
    if (failure) throw failure;
  };
  try {
    workflows = new WebWorkflowService({ gateway, dbPath: options.dbPath });
    const workflow = workflows;
    gateway.attachSourceLearning(workflow.learning.store);
    gateway.attachLearningRecorder(event => workflow.learning.recordChatOutcome(event));
    gateway.attachWorkflowLifecycle({ invoke: (sessionId, name, args, capabilities) => workflow.invokeLifecycle(sessionId, name, args, capabilities) });
    engine = new WorkflowEngineService({ token: options.engineBearer ?? options.controlToken, workspace: options.workspace, scopePath: options.scopePath, target: options.target, allowApply: options.allowApply, dbPath: options.dbPath, timeCapMs: options.timeCapMs, costCapUsd: options.costCapUsd }, { gateway, workflows: workflow });
    await engine.ready;
    triggers = new WorkflowTriggerService({ dbPath: options.dbPath, adapter: {
      async validate(trigger) {
        const sessionId = await gateway.prepareScheduledWorkflowOwner(trigger.sessionId);
        const context = await workflow.validateScheduledWorkflow(trigger.workflowId, { sessionId, revision: trigger.workflowRevision });
        return { model: context.model, providerId: context.providerId, ...(context.runtime instanceof LlmApiRuntime ? { connectionIdentity: context.runtime.connectionIdentity() } : {}) };
      },
      async launch(trigger) {
        const sessionId = await gateway.prepareScheduledWorkflowOwner(trigger.sessionId);
        const result = await workflow.launchScheduledWorkflow(trigger.workflowId, { sessionId, revision: trigger.workflowRevision });
        return { executionId: result.execution.id };
      },
    } });
    github = new GitHubPublicationAuth();
    return { skills, gateway, engagements, operator, workflows: workflow, engine, triggers, github, dispose };
  } catch (cause) { await dispose().catch(() => {}); throw cause; }
}
