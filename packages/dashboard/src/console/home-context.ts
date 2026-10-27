import type { ConsoleSessionSnapshot } from "@0/shared";
import type { ProjectResponse } from "@/components/console-control/contracts";

export interface HomeSuggestion { icon:"code"|"shield"|"plan"; label:string; hint:string; prompt:string }
export function selectedWorkspacePath(snapshot:ConsoleSessionSnapshot):string|undefined {
  const path=snapshot.workspacePath ?? snapshot.execution?.workspacePath;
  return typeof path === "string" && path.trim() ? path : undefined;
}
const comparablePath=(path:string)=>path.replaceAll("\\","/").replace(/\/+$/,"");
/** Metadata is usable only for the explicitly selected folder queried on this chat's host. */
export function homeSuggestions(snapshot:ConsoleSessionSnapshot,metadata?:{requestedPath:string;project:ProjectResponse}):HomeSuggestion[] {
  const finding=snapshot.focusedFinding;
  if(finding)return [
    {icon:"shield",label:"Review this finding",hint:finding.title,prompt:`Review the stored evidence for the focused finding "${finding.title}". Explain what is confirmed and what still needs verification.`},
    {icon:"plan",label:"Plan a verification",hint:"Start with the evidence and scope",prompt:"Propose a bounded verification plan for the focused finding, using its retained evidence and authorized scope."},
    {icon:"code",label:"Explore a fix",hint:"Compare remediation and regression checks",prompt:"Explain remediation options for the focused finding, including a regression check. Start with a proposal."},
  ];
  const workspace=selectedWorkspacePath(snapshot);
  const project=workspace && metadata?.requestedPath===workspace?metadata.project:undefined;
  const pending=snapshot.todos?.todos.find(todo=>!["completed","cancelled"].includes(todo.status));
  if(workspace){
    const path=project?.path || workspace;
    const git=project?.git.root && !project.git.error?project.git:undefined;
    const repoChanges=Boolean(git?.dirty && comparablePath(git.root!)===comparablePath(path));
    const scope=`the selected workspace ${JSON.stringify(path)}`;
    return [
      {icon:"code",label:git?"Whitebox pentest":"Explore this workspace",hint:git?`${project?.name} · ${git.branch || "Git repository"}`:path,prompt:git?`Run a whitebox pentest of ${scope}. First inspect its structure, trust boundaries and existing checks; trace exploitable code paths, keep the work scoped to this folder and report evidence separately from hypotheses.`:`Inspect ${scope} and summarize what is present before proposing a focused security review. Do not assume its language, project type or available tools.`},
      repoChanges?{icon:"shield",label:"Review uncommitted changes",hint:"The selected repository has local changes",prompt:`Review the current uncommitted changes in ${scope} for security issues and regressions. Read the diff first and preserve the working tree.`}:{icon:"shield",label:git?"Explain this project":"Find project context",hint:"Inspect documentation and manifests where present",prompt:`Explain ${scope} from its README, documentation and project manifests where present. Identify entry points and how it is built or run; state what could not be determined.`},
      pending?{icon:"plan",label:"Continue the pending task",hint:pending.content,prompt:`Continue the pending task: ${pending.content}. Use the preserved context and avoid repeating completed work.`}:{icon:"plan",label:"Plan a focused review",hint:"Choose useful checks before running them",prompt:`Propose a focused security review of ${scope}. Identify useful checks from the observed project structure and keep time and cost limits explicit before execution.`},
    ];
  }
  const target=snapshot.localScopePath || snapshot.session.target;
  if(target)return [
    {icon:"shield",label:"Review this target",hint:target,prompt:`Review ${JSON.stringify(target)} for security issues. Start by identifying the authorized scope and evidence to inspect.`},
    {icon:"code",label:"Inspect the available evidence",hint:"Separate observations from hypotheses",prompt:`Inspect the available evidence for ${JSON.stringify(target)} and distinguish verified issues from unconfirmed concerns.`},
    {icon:"plan",label:"Plan a focused review",hint:"Establish useful checks and limits",prompt:`Create a focused security review plan for ${JSON.stringify(target)}, with explicit scope, time and cost limits before execution.`},
  ];
  return [
    {icon:"code",label:"Whitebox pentest",hint:"Choose a source repository",prompt:"Help me start a whitebox pentest. First ask me to choose the source repository or workspace folder and establish its scope."},
    {icon:"shield",label:"Investigate a question",hint:"Start from evidence and constraints",prompt:"Help me investigate a security question. Ask for the relevant evidence and constraints first."},
    {icon:"plan",label:"Plan a workflow",hint:"Choose a target and useful checks",prompt:"Help me plan a security workflow with a target, authorized scope, and time and cost limits."},
  ];
}
