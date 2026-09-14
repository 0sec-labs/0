import { z } from "zod";
import { toolExecutorCheckpointSchema } from "../agent/tools.js";
import type { ToolContext } from "../agent/types.js";
import type { NativeMessage } from "../runtime/types.js";
import type { SelfExtensionSnapshot } from "../plugins/self-extension.js";
import type { LiveHarnessCheckpoint } from "../plugins/live-harness.js";
import type { ScopeJson } from "../scope/scope.js";
import { isAbsolute } from "node:path";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const absolutePath = z.string().refine(isAbsolute, "Expected an absolute path");
const scopeSchema: z.ZodType<ScopeJson> = z.object({
  in_scope: z.array(z.string()).optional(),
  out_of_scope: z.array(z.string()).optional(),
  attribution: z.object({
    headers: z.record(z.string()).optional(),
    user_agent_token: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
const messageSchema: z.ZodType<NativeMessage> = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.unknown()) }).strict(),
    z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.string(), is_error: z.boolean().optional() }).strict(),
  ])),
  providerRaw: z.custom<NativeMessage["providerRaw"]>().optional(),
}).strict();

/** In-process data ABI. Incompatible engine changes must explicitly migrate it. */
export const consoleSessionCheckpointSchema = z.object({
  version: z.literal(1),
  scanId: z.string().min(1),
  workspaceRoot: absolutePath,
  role: z.enum(["discovery", "attack", "verify", "report", "audit", "review"]),
  messages: z.array(messageSchema),
  autonomyMode: z.enum(["yolo", "standard", "copilot", "recon"]),
  target: z.string(),
  // Null means deliberately unset. Missing authority fields are rejected, not defaulted.
  configuredScope: scopeSchema.nullable(),
  grantedScope: scopeSchema.nullable(),
  localScopePath: absolutePath.nullable(),
  deniedHosts: z.array(z.string()),
  deniedShellPayloads: z.array(z.string()),
  deniedLocalPaths: z.array(absolutePath),
  systemPrompt: z.string().nullable(),
  objective: z.object({ value: z.string(), refined: z.boolean() }).strict(),
  sessionData: z.object({
    findings: z.array(z.custom<ToolContext["findings"][number]>(record)),
    attackResults: z.array(z.custom<ToolContext["attackResults"][number]>(record)),
    targetInfo: z.custom<ToolContext["targetInfo"]>(record),
    loadedSkills: z.array(z.string()),
    recentToolResultTexts: z.array(z.string()),
  }).strict(),
  executor: toolExecutorCheckpointSchema,
  loadedMcpTools: z.array(z.string()),
  selfExtensionEnabled: z.boolean(),
  // The registry and harness validate their own versioned provenance on restore.
  selfExtensionSnapshot: z.custom<SelfExtensionSnapshot>(record).nullable(),
  harnessRoot: absolutePath.nullable(),
  harness: z.custom<LiveHarnessCheckpoint>(record).nullable(),
}).strict().superRefine((checkpoint, context) => {
  const hasExtensionState = checkpoint.selfExtensionSnapshot !== null && checkpoint.harnessRoot !== null && checkpoint.harness !== null;
  const hasNoExtensionState = checkpoint.selfExtensionSnapshot === null && checkpoint.harnessRoot === null && checkpoint.harness === null;
  if (checkpoint.selfExtensionEnabled ? !hasExtensionState || checkpoint.role === "verify" : !hasNoExtensionState) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent self-extension handoff state" });
  }
});

export type ConsoleSessionCheckpoint = z.infer<typeof consoleSessionCheckpointSchema>;
