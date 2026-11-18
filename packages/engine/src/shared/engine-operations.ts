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
  { id: "list_work", capability: "workflows", effect: "read" },
  { id: "get_work", capability: "workflows", effect: "read" },
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
export const ENGINE_COMMAND_COVERAGE: readonly EngineCommandCoverage[] = [];
