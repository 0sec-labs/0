import { z } from "zod";

/** Operation dispatch and UI/tool availability are separate from transport capabilities. */
export const ENGINE_OPERATION_DEFINITIONS = [
  { id: "get_capabilities", capability: "operator-services", effect: "read" },
  { id: "start_assessment", capability: "workflows", effect: "execute" },
  { id: "attach_session", capability: "sessions", effect: "read" },
  { id: "get_session_events", capability: "events", effect: "read" },
  { id: "list_templates", capability: "workflows", effect: "read" },
  { id: "get_template", capability: "workflows", effect: "read" },
  { id: "list_workflows", capability: "workflows", effect: "read" },
  { id: "get_workflow", capability: "workflows", effect: "read" },
  { id: "save_workflow", capability: "workflows", effect: "write" },
  { id: "start_run", capability: "workflows", effect: "execute" },
  { id: "list_runs", capability: "workflows", effect: "read" },
  { id: "get_run", capability: "workflows", effect: "read" },
  { id: "get_run_results", capability: "workflows", effect: "read" },
  { id: "cancel_run", capability: "workflows", effect: "cancel" },
  { id: "list_sessions", capability: "sessions", effect: "read" },
  { id: "create_session", capability: "sessions", effect: "write" },
  { id: "get_session", capability: "sessions", effect: "read" },
  { id: "send_message", capability: "sessions", effect: "execute" },
  { id: "continue_session", capability: "sessions", effect: "execute" },
  { id: "cancel_session", capability: "sessions", effect: "cancel" },
  { id: "resolve_decision", capability: "approvals", effect: "approve" },
  { id: "list_saved_sessions", capability: "sessions", effect: "read" },
  { id: "resume_session", capability: "sessions", effect: "execute" },
  { id: "resume_scan", capability: "scan-resume", effect: "execute" },
] as const;
export type EngineOperationId = typeof ENGINE_OPERATION_DEFINITIONS[number]["id"];
export type EngineOperationDefinition = typeof ENGINE_OPERATION_DEFINITIONS[number];
export const ENGINE_REPORT_FORMATS = ["json", "md", "html", "sarif", "pdf"] as const;
export type EngineReportFormat = typeof ENGINE_REPORT_FORMATS[number];
const operationIds = ENGINE_OPERATION_DEFINITIONS.map(operation => operation.id);
const OperationIdSchema = z.enum(operationIds as [EngineOperationId, ...EngineOperationId[]]);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const EngineCapabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  operations: z.array(OperationIdSchema).refine(unique, "Engine operations must be unique"),
  reportExport: z.object({ formats: z.array(z.enum(ENGINE_REPORT_FORMATS)).refine(unique, "Report formats must be unique") }).strict(),
  resume: z.object({ session: z.boolean(), scan: z.boolean(), workflow: z.literal(false) }).strict(),
}).strict().superRefine((manifest, context) => {
  if (manifest.resume.session !== manifest.operations.includes("resume_session") || manifest.resume.scan !== manifest.operations.includes("resume_scan")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Resume support must match registered operations" });
  }
});
export type EngineCapabilityManifest = z.infer<typeof EngineCapabilityManifestSchema>;
/** No defaults imply dispatch support: the owning facade explicitly registers each port. */
export function createEngineCapabilityManifest(options: { operations: readonly EngineOperationId[]; reportFormats?: readonly EngineReportFormat[] }): EngineCapabilityManifest {
  return EngineCapabilityManifestSchema.parse({ schemaVersion: 1, operations: [...options.operations], reportExport: { formats: [...(options.reportFormats ?? [])] },
    resume: { session: options.operations.includes("resume_session"), scan: options.operations.includes("resume_scan"), workflow: false } });
}
export function requireEngineOperation(manifest: EngineCapabilityManifest, operation: EngineOperationId): void {
  const valid = EngineCapabilityManifestSchema.parse(manifest);
  if (!valid.operations.includes(operation)) throw new Error(`Engine does not support operation ${operation}.`);
}

export interface EngineCommandCoverage {
  id: string;
  classification: "workflow" | "chat-tool" | "cli-specialist" | "cli-maintenance";
  cliCommands: readonly string[];
  workflowSteps: readonly string[];
  templateIds: readonly string[];
  chatTools: readonly string[];
  limits: string;
  source: string;
}
/** Verified adapter coverage, not a dispatch allowlist or a grant to execute a tool. */
export const ENGINE_COMMAND_COVERAGE: readonly EngineCommandCoverage[] = [
  { id: "assessment", classification: "workflow", cliCommands: ["scan", "review", "audit", "secure"], workflowSteps: ["audit"], templateIds: ["repository-review", "dependency-review", "api-security", "web-configuration", "scoped-penetration-test", "package-behavior", "contract-review", "native-code-review"], chatTools: [], limits: "Target-specific assessment options and admission still apply.", source: "packages/core/src/assessment.ts" },
  { id: "fix", classification: "workflow", cliCommands: ["fix"], workflowSteps: ["fix"], templateIds: ["fix-candidate"], chatTools: ["generate_fix"], limits: "Chat generation is distinct from workflow candidate validation; applying requires exact live candidate proof and host/request approval.", source: "packages/cli/src/finding-workflow-executors.ts" },
  { id: "verification", classification: "workflow", cliCommands: ["verify", "replay"], workflowSteps: ["verify"], templateIds: ["finding-verification"], chatTools: ["verify_finding"], limits: "Managed verification uses supported replay runners; CLI kernel verification is not a portable workflow operation.", source: "packages/cli/src/finding-workflow-executors.ts" },
  { id: "research", classification: "workflow", cliCommands: ["research pipeline", "research mobile", "research linux-matrix"], workflowSteps: ["research"], templateIds: ["security-research"], chatTools: [], limits: "Managed modes pipeline/mobile/linux-matrix require authorized local workspace; pipeline is source-only. linux-matrix imports external evidence and does not execute boots.", source: "packages/cli/src/workflow-research-executors.ts" },
  { id: "deep-review", classification: "workflow", cliCommands: ["deep-review"], workflowSteps: ["deep-review"], templateIds: ["deep-source-review"], chatTools: [], limits: "Authorized local source workspace and provider prerequisites apply.", source: "packages/cli/src/workflow-research-executors.ts" },
  { id: "offensive-tools", classification: "chat-tool", cliCommands: ["hunt", "assumption-hunt", "protocol-check", "specdrift", "memsafety", "npm-discovery", "kernel", "cve"], workflowSteps: [], templateIds: [], chatTools: ["variant_hunt", "assumption_hunt", "protocol_conformance", "spec_drift", "safety_eval", "memsafety_fuzz", "npm_dynamic_discovery", "weaponize_kernel", "cve_adapt"], limits: "Tool availability is scope/feature/prerequisite gated. CLI engines and tools have different contracts; no portable specialist workflow executor is registered by this manifest.", source: "packages/core/src/agent/tools/offensive-engines.ts" },
  { id: "kernel-research", classification: "cli-specialist", cliCommands: ["research linux"], workflowSteps: [], templateIds: [], chatTools: [], limits: "Managed kernel research rejects execution until the VM/build runner supports workflow cancellation and deadlines.", source: "packages/cli/src/workflow-research-executors.ts" },
  { id: "specialist-cli", classification: "cli-specialist", cliCommands: ["binary", "exploit", "recency-hunt", "lens-synth", "xnu-fuzz", "disclose", "eval", "bench", "ingest"], workflowSteps: [], templateIds: [], chatTools: [], limits: "These CLI contracts are not exposed as portable workflow steps here; model-driven source review is not equivalent to their native proof engines.", source: "packages/cli/src/index.ts" },
  { id: "maintenance", classification: "cli-maintenance", cliCommands: ["doctor", "db", "upgrade", "config", "plugin", "theme", "login", "logout"], workflowSteps: [], templateIds: [], chatTools: [], limits: "Host maintenance and credential changes are not workflow execution or model-tool grants.", source: "packages/cli/src/index.ts" },
];
