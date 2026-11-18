import { workerPolicySchema } from "../workflow-execution-policy.js";
import { z } from "zod";
import { toolExecutorCheckpointSchema } from "../agent/tools.js";
import type { ToolContext } from "../agent/types.js";
import type { NativeMessage } from "../runtime/types.js";
import { isAbsolute } from "node:path";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const absolutePath = z.string().refine(isAbsolute, "Expected an absolute path");
const messageSchema: z.ZodType<NativeMessage> = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }).strict(),
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
  // Any value an older release stored (standard, copilot, recon, read-only, ...) loads as the one mode; new checkpoints write the constant "changes" so older readers still accept them.
  autonomyMode: z.string().optional(),
  webSearchEnabled: z.boolean().optional(),
  workerPolicy: workerPolicySchema.optional(),
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
  // Legacy field name retained for v1 compatibility; includes deferred built-ins.
  loadedMcpTools: z.array(z.string()),
  // Written by releases that had model-authored executable plugins and a live harness. Both are gone: the fields are
  // accepted so an old checkpoint still restores, and ignored.
  selfExtensionEnabled: z.unknown().optional(),
  selfExtensionSnapshot: z.unknown().optional(),
  harnessRoot: z.unknown().optional(),
  harness: z.unknown().optional(),
  // Written by releases that had scope. Accepted so an old checkpoint still restores, and ignored.
  target: z.unknown().optional(),
  configuredScope: z.unknown().optional(),
  grantedScope: z.unknown().optional(),
  localScopePath: z.unknown().optional(),
  deniedHosts: z.unknown().optional(),
  deniedShellPayloads: z.unknown().optional(),
  deniedLocalPaths: z.unknown().optional(),
}).strict();

export type ConsoleSessionCheckpoint = z.infer<typeof consoleSessionCheckpointSchema>;
