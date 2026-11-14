/**
 * Console session transcripts, persisted to `~/.0/console-sessions/<id>.json`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS WRITES TO DISK, AND WHY IT IS SENSITIVE
 * ─────────────────────────────────────────────────────────────────────────────
 * This store persists the *entire* native message array of a console session:
 * every operator prompt, every model reply, and every tool call together with
 * its full result. On a security tool that is engagement content, not chat
 * history. In practice a single file here can contain:
 *
 *   - target hostnames, IPs, internal URLs and the scope an operator approved;
 *   - discovered findings before they are triaged, redacted or disclosed;
 *   - raw HTTP requests and responses captured as exploit evidence, including
 *     session cookies, bearer tokens and CSRF tokens seen on the wire;
 *   - file contents and command output from the operator's own machine;
 *   - credentials the operator pasted into the console, or that a tool echoed.
 *
 * It is written because operators want to close the console and pick the
 * engagement back up — `ConsoleSession` already accepts `initialMessages`, so
 * restoring a session is exactly "hand back the array we stored". The cost of
 * that convenience is a durable, plaintext copy of the above sitting in the
 * operator's home directory, which is a fact both they and any future
 * maintainer of this file need to hold in mind.
 *
 * The transcript is stored FAITHFULLY. This module deliberately does not
 * attempt to scrub secrets out of it, and that is a decision, not an omission.
 * A scrubber over free-form tool output cannot be complete — it would catch
 * `Authorization: Bearer …` and miss the same token inside a JSON body, a
 * base64 blob, a JWT in a URL, or a password in a stack trace — and a partial
 * scrub is worse than none: it advertises a guarantee it cannot keep, so the
 * file gets treated as safe to copy into a ticket, a bug report or a shared
 * host. It would also corrupt the very evidence a resumed session needs. So
 * the contract is the honest one: everything is kept, nothing is sanitised,
 * and the protection is filesystem permissions plus the operator's ability to
 * delete.
 *
 * Consequences, enforced here rather than left to callers:
 *
 *   1. Files are 0600 and the directory is 0700, re-applied on every save so
 *      an entry left loose by an older build, a restored backup or a hand-edit
 *      is tightened rather than trusted.
 *   2. Nothing is transmitted anywhere. This is local disk only — no upload,
 *      no telemetry, no cloud sync path.
 *   3. Deletion is first-class: `deleteSession` removes one transcript and
 *      `pruneSessions` caps how much history accumulates, so the store does
 *      not silently retain an operator's engagements forever.
 *   4. Nothing here prints, on any path. This runs inside a TUI that owns the
 *      terminal, and the payloads involved are exactly the ones that must not
 *      reach a scrollback buffer or a CI log.
 *
 * Like the settings and credential stores next door, every function is TOTAL:
 * a missing directory, an unreadable file, malformed JSON or a read-only home
 * is reported as an empty/false/null result, never as an exception. A bad
 * history file may not take down a live console.
 */

import { linkSync, unlinkSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import type { ConsoleJsonValue } from "@0/engine/shared";

import { homeStateDir } from "@0/engine/shared";

/** Listing entry: everything needed to describe a session without loading it. */
export interface StoredSessionMeta {
  /** Hidden from the main chat list, retained for restore/export. */
  archived?: boolean;
  /** Stable session id — the `ConsoleSession.scanId`, and the filename stem. */
  id: string;
  /**
   * Epoch milliseconds, INJECTED by the caller. Nothing in this module reads
   * the clock: a store whose ordering depends on an ambient `Date.now()` can
   * only be tested by mocking global time, and the codebase forbids
   * nondeterministic clocks in logic that has tests.
   */
  savedAt: number;
  /** Engagement target at save time, when the session had one. */
  target?: string;
  /** Model id the session was running on, for the listing. */
  model?: string;
  /** Autonomy mode at save time, for the listing. */
  mode?: string;
  /** Working directory the console ran in; the default listing filter. */
  cwd: string;
  /** Number of native messages in the transcript. */
  messageCount: number;
  /** First operator message, trimmed, for a human-readable listing. */
  preview: string;
  /**
   * A short "what this engagement was about / did" objective, supplied by the
   * caller (chat-screen passes the session objective at save time). Unlike
   * `preview` — which is mechanically the first operator message — this is an
   * intent line the resume UI can show so a row says what the session was
   * *for*, not merely how it opened. Optional: absent when the caller had no
   * objective to record, and sanitised exactly like `preview` (single line,
   * control-stripped, length-capped) since it is rendered into the terminal
   * from a file a hostile local process could have rewritten.
   */
  summary?: string;
}

/** A full transcript: the listing metadata plus the messages to replay. */
export interface StoredSession extends StoredSessionMeta {
  /**
   * The session's native message array, stored opaquely. Typed `unknown[]` on
   * purpose: this module is a byte pipe for `NativeMessage[]` and must not
   * acquire a compile-time dependency on a shape the engine is free to evolve.
   * The caller casts on the way back into `initialMessages`.
   */
  messages: unknown[];
  /** Bounded display state only. Never passed to an engine checkpoint/configuration. */
  consoleState?: StoredConsoleState;
}

/** Subdirectory of the 0 state dir holding one JSON file per session. */
const SESSIONS_DIRNAME = "console-sessions";

/** Owner-only: nobody else on the machine has business reading a transcript. */
const FILE_MODE = 0o600;
/**
 * Owner-only on the directory too. A 0600 file inside a 0755 directory still
 * leaks the session ids, the count and the sizes of an operator's engagements
 * to every local account, and a group- or world-*writable* directory would let
 * another account replace a transcript wholesale — which, since transcripts get
 * replayed straight back into a live model context, is a content-injection
 * primitive rather than a mere disclosure.
 */
const DIR_MODE = 0o700;

/** How many sessions `pruneSessions` keeps when the caller names no limit. */
export const DEFAULT_PRUNE_KEEP = 20;

/** Longest preview retained; a listing row is one terminal line, not a page. */
const PREVIEW_MAX_LENGTH = 120;

/**
 * Longest summary retained. Held to the same one-line budget as the preview:
 * the objective shares the listing row with the preview, and a summary that ran
 * to a paragraph would defeat the point of a scannable resume picker.
 */
const SUMMARY_MAX_LENGTH = 120;

/**
 * Ids are used as filenames, so this pattern is a security boundary, not a
 * tidiness rule: it must reject anything that could escape `sessionsDir`.
 * Requiring an alphanumeric first character kills `..` and dotfiles outright,
 * and the allow-list body admits no `/`, no `\`, no NUL and nothing
 * shell-interesting. Console ids are `console-<uuid>`, which fits comfortably.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** File suffix; also what `listSessions` uses to recognise its own files. */
const FILE_SUFFIX = ".json";

/**
 * Transcripts live beside the rest of the per-user engine state (scan DB,
 * journals, credentials, TUI settings) rather than in a bespoke directory, so
 * `homeStateDir` from `@0/engine/shared` — not a local `".0"` literal — decides
 * where that is. One definition of the state root means a future relocation or
 * an `$XDG_STATE_HOME` migration happens in one place, and — for a directory
 * full of engagement data — that such a relocation cannot leave a stale copy
 * behind in a path only this file knew about.
 */
export function sessionsDir(homeDir?: string): string {
  return join(homeStateDir(homeDir), SESSIONS_DIRNAME);
}

/** Whether `id` is safe to use as a filename inside `sessionsDir`. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}

/** Absolute path of one session file, or null when the id is not usable. */
function sessionFilePath(id: unknown, homeDir?: string): string | null {
  if (!isValidSessionId(id)) return null;
  return join(sessionsDir(homeDir), `${id}${FILE_SUFFIX}`);
}

/** Read only own data fields; metadata access never executes a getter. */
function rawValue(raw: unknown, key: string): unknown {
  const property = ownDataProperty(raw, key);
  return property && "value" in property ? property.value : undefined;
}

/** A non-blank string value, or undefined — optional fields stay absent. */
function optionalString(raw: unknown, key: string): string | undefined {
  const value = rawValue(raw, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Control characters (C0 + DEL + C1), the ANSI-escape building blocks. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]+/g;

/**
 * Preview text is rendered into a terminal listing, and it arrives from a file
 * on disk that a hostile local process — or a restored backup, or a hand-edit —
 * could have rewritten. Control characters are stripped rather than escaped so
 * a crafted transcript cannot smuggle ANSI sequences into the operator's
 * terminal (cursor moves, colour resets, or a clear-screen that hides which
 * session they are about to resume). Whitespace collapses for the same reason:
 * one entry is one line.
 */
function sanitizeLine(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const flattened = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

function sanitizePreview(value: unknown): string {
  return sanitizeLine(value, PREVIEW_MAX_LENGTH);
}

/**
 * A sanitised summary, or undefined. Runs the same control-stripping and
 * length cap as the preview, but collapses a blank/non-string/absent value to
 * `undefined` rather than `""` so an unset objective is an *omitted* field — the
 * listing distinguishes "no objective recorded" from an empty one, and a
 * corrupt or oversized value on disk normalises down instead of throwing.
 */
function sanitizeSummary(value: unknown): string | undefined {
  const flattened = sanitizeLine(value, SUMMARY_MAX_LENGTH);
  return flattened.length > 0 ? flattened : undefined;
}

/**
 * Total coercion of a parsed file into listing metadata.
 *
 * `id` comes from the FILENAME, never from the body: the filename is the key
 * every other function addresses a session by, so a body whose `id` had drifted
 * (a copied file, a hand-edit) would otherwise produce a listing row that
 * `loadSession` cannot open. A non-finite `savedAt` sorts last rather than
 * rejecting the file — an unorderable transcript is still a recoverable one.
 */
export function storedSessionMetadata(id: string, raw: unknown, messageCount: number): StoredSessionMeta {
  const savedAt = rawValue(raw, "savedAt");
  const cwd = rawValue(raw, "cwd");
  const target = optionalString(raw, "target");
  const model = optionalString(raw, "model");
  const mode = optionalString(raw, "mode");
  const summary = sanitizeSummary(rawValue(raw, "summary"));
  return {
    id,
    savedAt: typeof savedAt === "number" && Number.isFinite(savedAt) ? savedAt : 0,
    ...(target !== undefined ? { target } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(mode !== undefined ? { mode } : {}),
    cwd: typeof cwd === "string" ? cwd : "",
    messageCount,
    preview: sanitizePreview(rawValue(raw, "preview")),
    ...(rawValue(raw, "archived") === true ? { archived: true } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

const finite = z.number().finite().nonnegative();
const boundedString = z.string().max(1_000_000);
const jsonValueSchema: z.ZodType<ConsoleJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), boundedString,
  z.array(jsonValueSchema).max(10_000), z.record(z.string(), jsonValueSchema),
]));
const toolCallSchema = z.object({ id: z.string().max(256).optional(), name: z.string().max(256), arguments: jsonValueSchema }).strict();
const workerTurnSchema = z.object({
  turn: finite, ts: finite, assistant: boundedString.optional(), reasoning_summary: boundedString.optional(), partial: z.boolean().optional(),
  tools: z.array(z.object({ callIndex: finite, call: toolCallSchema, result: jsonValueSchema, running: z.boolean().optional() }).strict()).max(1_000).optional(),
}).strict();
const messageAuthorSchema = z.object({ userId: z.string().min(1).max(256), displayName: z.string().min(1).max(256), proposalId: z.string().min(1).max(256).optional() }).strict();
const workerSchema = z.object({
  id: z.string().max(256), parentId: z.string().max(256), name: z.string().max(200),
  status: z.enum(["queued", "running", "parked", "completed", "failed", "stopped"]), task: boundedString,
  transcript: z.array(workerTurnSchema).max(10_000), telemetry: z.record(z.string(), jsonValueSchema).optional(),
  operatorMessages: z.array(z.object({ id: z.string().max(256), text: boundedString, createdAt: z.string().max(64), author: messageAuthorSchema.optional() }).strict()).max(10_000).optional(),
  summary: boundedString.optional(), error: boundedString.optional(), model: z.string().max(256).optional(), role: z.string().max(64).optional(),
}).strict();
const executionQuarantineSchema = z.object({
  reason: z.string().trim().min(1).max(2_000).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  recordedAt: z.string().datetime().max(64),
}).strict();
const consoleStateSchema = z.object({
  /** Private execution safety state; never include in metadata-only listings. */
  executionQuarantine: executionQuarantineSchema.optional(),
  configuration: z.object({
    workerPolicy: z.object({
      allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).max(512).refine(names => new Set(names).size === names.length).optional(),
      allowedHttpMethods: z.array(z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"])).max(7).refine(methods => new Set(methods).size === methods.length).optional(),
      maxTurns: z.number().int().min(1).max(10_000).optional(),
    }).strict().optional(),
    modelSource: z.literal("local").optional(),
    webSearchEnabled: z.boolean().optional(),
    workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    skillId: z.string().min(1).max(384).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
    skillAllowList: z.array(z.string().min(1).max(384).regex(/^[A-Za-z0-9_.:/-]+$/)).max(64).optional(),
    parentSessionId: z.string().min(1).max(128).optional(),
    target: z.string().max(8_000), role: z.enum(["discovery", "attack", "verify", "report", "audit", "review"]),
    runtime: z.object({
      providerId: z.string().max(256).optional(), model: z.string().max(256).optional(),
      connectionIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      cyberAccessProgram: z.enum(["standard", "daybreak_blue", "daybreak_red"]).nullable().optional(),
      reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
      agentModels: z.record(z.string(), z.string().max(256)).optional(), singleModel: z.boolean().optional(), autoRoute: z.boolean().optional(),
    }).strict(),
  }).strict().optional(),
  version: z.literal(1), title: z.string().max(200), titleSource: z.enum(["default", "auto", "user"]).optional(), objective: z.string().max(8_000),
  usage: z.object({
    inputTokens: finite, outputTokens: finite, costUsd: finite.optional(),
    costKind: z.enum(["estimated", "reported"]).optional(), costUnavailable: z.boolean().optional(),
  }).strict(),
  contextInputTokens: finite.optional(),
  lastOutcome: z.object({
    assistantText: boundedString, stopReason: z.enum(["end_turn", "max_tool_iterations", "max_turn_tokens", "output_cap", "no_progress", "cancelled", "error"]),
    budget: z.object({ tokensUsed: finite, tokenBudget: finite.nullable(), iterations: finite, maxToolIterations: finite.nullable() }).strict(),
    error: boundedString.optional(), usage: z.object({ inputTokens: finite, outputTokens: finite }).strict().optional(),
    contextInputTokens: finite.optional(),
    outputCap: z.object({ checkpoint: jsonValueSchema, continuations: finite, message: boundedString }).strict().optional(),
  }).strict().nullable(),
  todos: z.object({
    todos: z.array(z.object({ id: z.string().max(256), content: z.string().max(8_000), status: z.string().max(64), group: z.string().max(200).optional() }).strict()).max(1_000),
    done: finite, total: finite, line: z.string().max(8_000), revision: finite,
  }).strict().nullable(),
  workers: z.array(workerSchema).max(1_000),
  compaction: jsonValueSchema.nullable(),
  queuedMessages: z.array(z.object({ attachments: z.array(z.object({ kind: z.enum(["path", "text", "image"]), value: z.string().max(650_000), name: z.string().max(256).optional() }).strict()).max(20).optional(), id: z.string().max(256), text: boundedString, createdAt: z.string().max(64), author: messageAuthorSchema.optional() }).strict()).max(20),
  userAttributions: z.array(z.object({ text: boundedString, author: messageAuthorSchema.optional() }).strict()).max(10000).optional(),
  focusedFindingId: z.string().max(256).optional(),
  stagedPrompt: boundedString.optional(),
}).strict();
export type StoredConsoleState = z.infer<typeof consoleStateSchema>;

/** Only own data properties may participate in private safety recovery. */
function ownDataProperty(value: unknown, key: string): PropertyDescriptor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key);
}

/** Copy JSON data before schema/serialization; never invoke source getters or hooks.
 * Recursion, node count and serialized size are independently bounded. */
function boundedDataCopy(value: unknown, limits = { depth: 24, nodes: 100_000, size: 4 * 1024 * 1024, string: 1_000_000 }): unknown {
  let nodes = 0, size = 0;
  const ancestors = new Set<object>();
  const charge = (amount: number) => { size += amount; if (size > limits.size) throw new Error("Metadata size limit"); };
  const copy = (entry: unknown, depth: number): unknown => {
    if (++nodes > limits.nodes || depth > limits.depth) throw new Error("Metadata tree limit");
    if (entry === null || typeof entry === "boolean") { charge(5); return entry; }
    if (typeof entry === "string") {
      if (entry.length > limits.string || entry.length > limits.size) throw new Error("Metadata string limit");
      charge(JSON.stringify(entry).length); return entry;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) { charge(String(entry).length); return entry; }
    if (!entry || typeof entry !== "object" || utilTypes.isProxy(entry) || ancestors.has(entry)) throw new Error("Metadata is not plain JSON data");
    const array = Array.isArray(entry), prototype = Object.getPrototypeOf(entry);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new Error("Metadata custom prototype");
    const keys = Reflect.ownKeys(entry);
    if (keys.length > limits.nodes) throw new Error("Metadata key limit");
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    ancestors.add(entry); charge(2);
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("Metadata symbol property");
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
      if (!("value" in descriptor)) throw new Error("Metadata accessor");
      if (array && key === "length") {
        if (descriptor.value > limits.nodes) throw new Error("Metadata array limit");
        continue;
      }
      if (!descriptor.enumerable) continue;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Metadata custom array property");
      if (key.length > limits.size) throw new Error("Metadata key size limit");
      charge(JSON.stringify(key).length + 2);
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    ancestors.delete(entry);
    return result;
  };
  try { return copy(value, 0); } catch { return undefined; }
}

/** Protected state is recovered BEFORE optional display bounds are considered. */
function parseConsoleState(value: unknown, recoverDisplayState = false): StoredConsoleState | undefined {
  const raw = (key: string) => { const property = ownDataProperty(value, key); return property && "value" in property ? property.value : undefined; };
  const marker = ownDataProperty(value, "executionQuarantine");
  const quarantine = executionQuarantineSchema.safeParse(boundedDataCopy(raw("executionQuarantine"), { depth: 2, nodes: 8, size: 16_384, string: 2_000 }));
  // Invalid saves must not overwrite an existing durable marker. On load even
  // an unreadable marker means unknown ownership, never permission to execute.
  if (marker && !quarantine.success && !recoverDisplayState) return undefined;
  const executionQuarantine = marker ? quarantine.success ? quarantine.data : {
    reason: "Saved execution quarantine is unreadable; resource cleanup remains unconfirmed.", recordedAt: "1970-01-01T00:00:00.000Z",
  } : undefined;
  const configuration = consoleStateSchema.shape.configuration.safeParse(boundedDataCopy(raw("configuration"), { depth: 6, nodes: 2_000, size: 262_144, string: 8_000 }));
  const protectedConfiguration = raw("version") === 1 && configuration.success ? configuration.data : undefined;
  // Paused instructions are private operator context, not disposable display.
  // These independent bounds exceed the former whole-state display budget.
  const contextLimits = { depth: 10, nodes: 10_000, size: 8 * 1024 * 1024, string: 1_000_000 };
  const queue = consoleStateSchema.shape.queuedMessages.safeParse(boundedDataCopy(raw("queuedMessages"), contextLimits));
  const protectedQueue = queue.success ? queue.data : [];
  const staged = consoleStateSchema.shape.stagedPrompt.safeParse(boundedDataCopy(raw("stagedPrompt"), contextLimits));
  const protectedStaged = staged.success ? staged.data : undefined;
  const minimal = (): StoredConsoleState | undefined => {
    if (!executionQuarantine && !protectedConfiguration) return undefined;
    return { version: 1, title: executionQuarantine ? "Quarantined chat" : "Resumed chat", objective: "", usage: { inputTokens: 0, outputTokens: 0, costUnavailable: true },
      lastOutcome: null, todos: null, workers: [], compaction: null, queuedMessages: protectedQueue,
      ...(protectedStaged !== undefined ? { stagedPrompt: protectedStaged } : {}),
      ...(protectedConfiguration ? { configuration: protectedConfiguration } : {}), ...(executionQuarantine ? { executionQuarantine } : {}) };
  };
  const clean = boundedDataCopy(value);
  if (clean === undefined) return recoverDisplayState || quarantine.success ? minimal() : undefined;
  const parsed = consoleStateSchema.safeParse(clean);
  if (parsed.success) return parsed.data;
  if (!recoverDisplayState) return quarantine.success ? minimal() : undefined;
  if (!protectedConfiguration) return minimal();
  // The complete data-only clone is bounded, so individual optional fields can
  // be recovered without decoding the original object again or running hooks.
  const field = <K extends keyof typeof consoleStateSchema.shape>(key: K, fallback: StoredConsoleState[K]): StoredConsoleState[K] => {
    const result = consoleStateSchema.shape[key].safeParse(ownDataProperty(clean, key)?.value);
    return result.success ? result.data as StoredConsoleState[K] : fallback;
  };
  return { version: 1, configuration: protectedConfiguration,
    ...(executionQuarantine ? { executionQuarantine } : {}),
    title: field("title", "Resumed chat"), objective: field("objective", ""), usage: field("usage", { inputTokens: 0, outputTokens: 0 }),
    lastOutcome: field("lastOutcome", null), todos: field("todos", null), workers: field("workers", []), compaction: field("compaction", null),
    queuedMessages: protectedQueue, ...(protectedStaged !== undefined ? { stagedPrompt: protectedStaged } : {}), userAttributions: field("userAttributions", []),
    ...(field("contextInputTokens", undefined) !== undefined ? { contextInputTokens: field("contextInputTokens", undefined) } : {}),
  };
}

/**
 * Parses one file into a full session, or null.
 *
 * The one HARD requirement is `messages`: it is the only field whose consumer
 * cannot degrade, since it is replayed straight into a model context. A file
 * whose `messages` is missing, a string, an object or anything else is rejected
 * outright rather than repaired into an empty array — resuming into a silently
 * truncated engagement is far worse for an operator than being told the session
 * is gone, because the model would confidently continue without the context
 * that justified its earlier conclusions.
 */
function parseSession(id: string, text: string): StoredSession | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const messages = rawValue(raw, "messages");
  if (!Array.isArray(messages)) return null;
  const consoleState = parseConsoleState(rawValue(raw, "consoleState"), true);
  // A corrupt retained ceiling must never silently become an unrestricted resume.
  if (rawValue(rawValue(rawValue(raw, "consoleState"), "configuration"), "workerPolicy") !== undefined && !consoleState?.configuration?.workerPolicy) return null;
  return { ...storedSessionMetadata(id, raw, messages.length), messages, ...(consoleState ? { consoleState } : {}) };
}

/**
 * Persists one transcript with owner-only permissions, reporting success as a
 * return value rather than an exception — a read-only or full home directory is
 * a "could not save" notice in the transcript, not a lost console.
 *
 * Permissions are applied twice on purpose. The `mode` option on `writeFileSync`
 * and `mkdirSync` only takes effect when the entry is *created*, and even then
 * it is masked by the process umask; an existing world-readable file would keep
 * its loose mode silently. The explicit `chmodSync` calls therefore run
 * unconditionally, so every save is also a repair. `mode` on the create path
 * still matters: it closes the window between "file exists with the default
 * mode" and "chmod lands", during which the transcript would be readable.
 *
 * `messageCount` and `preview` are recomputed from the payload rather than
 * trusted from the caller, so a listing can never claim a size the stored
 * transcript does not have. A caller-supplied `summary` (on the `StoredSession`)
 * is carried through `toMeta`, which sanitises it to a single capped line and
 * drops it when blank — the field is persisted only when there is one to keep.
 */
export function saveSession(session: StoredSession, homeDir?: string): boolean {
  return persistSession(session, homeDir, false);
}

/** Publish a new private transcript without replacing any existing destination. */
export function createSessionSnapshot(session: StoredSession, homeDir?: string): boolean {
  return persistSession(session, homeDir, true);
}

function persistSession(session: StoredSession, homeDir: string | undefined, exclusive: boolean): boolean {
  let pendingPath: string | undefined;
  try {
    const messages = rawValue(session, "messages"), id = rawValue(session, "id");
    if (!Array.isArray(messages) || utilTypes.isProxy(messages) || !isValidSessionId(id)) return false;
    const path = sessionFilePath(id, homeDir);
    if (path === null) return false;
    const stateProperty = ownDataProperty(session, "consoleState");
    if (stateProperty && !("value" in stateProperty)) return false;
    const rawState = stateProperty?.value;
    const consoleState = rawState === undefined ? undefined : parseConsoleState(rawState);
    if (rawState !== undefined && !consoleState) return false;

    const dir = sessionsDir(homeDir);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);

    const payload: StoredSession = {
      ...storedSessionMetadata(id, session, messages.length),
      messages,
      ...(consoleState ? { consoleState } : {}),
    };
    // Not pretty-printed, unlike the settings file next door: this one is not
    // meant to be read by hand, and a transcript's indentation is pure bulk.
    // Replace only after the complete payload has been written. A failed write
    // must leave the previous resumable transcript intact. The sibling staging
    // file keeps rename atomic and is ignored by session discovery.
    const serialized = `${JSON.stringify(payload)}\n`;
    pendingPath = join(dir, `.${id}.${randomUUID()}.tmp`);
    writeFileSync(pendingPath, serialized, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    chmodSync(pendingPath, FILE_MODE);
    if (exclusive) {
      // Hard-link publication is atomic and fails if the name already exists.
      linkSync(pendingPath, path);
      try { unlinkSync(pendingPath); } catch { /* Published snapshot is complete; retry staging cleanup below. */ }
    } else renameSync(pendingPath, path);
    if (!exclusive) pendingPath = undefined;
    return true;
  } catch {
    return false;
  } finally {
    sessionMutationEpoch += 1;
    if (pendingPath !== undefined) {
      try { rmSync(pendingPath, { force: true }); } catch { /* Preserve the total store API on cleanup failures. */ }
    }
  }
}

/**
 * Lists stored sessions newest-first, skipping anything it cannot read.
 *
 * A single corrupt or truncated file — a save interrupted by a killed terminal
 * is the realistic case — must cost the operator that one session and no more,
 * which is why the store is one file per session and why every read here is
 * individually guarded.
 *
 * `cwd` filtering is the default expectation of a resume UI rather than an
 * afterthought: an operator resuming in project A being offered project B's
 * engagement is both noise and a small disclosure, since the preview line
 * carries the other engagement's subject.
 */
export function listSessions(
  homeDir?: string,
  opts?: { cwd?: string; limit?: number },
): StoredSessionMeta[] {
  const dir = sessionsDir(homeDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // A missing directory is the common case: nothing has ever been saved.
    return [];
  }

  const out: StoredSessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(FILE_SUFFIX)) continue;
    const id = entry.slice(0, -FILE_SUFFIX.length);
    // A file whose stem is not a valid id cannot have been written by us and
    // cannot be addressed by `loadSession`, so listing it would only offer the
    // operator a row that fails to open.
    if (!isValidSessionId(id)) continue;

    let text: string;
    try {
      text = readFileSync(join(dir, entry), "utf8");
    } catch {
      continue;
    }
    // A history listing needs only the row metadata. Loading a full session
    // also validates/clones its potentially large console display state; doing
    // that for every saved chat on each sidebar poll wastes work and used to
    // accidentally include consoleState in this metadata-only response.
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { continue; }
    const messages = rawValue(raw, "messages");
    if (!Array.isArray(messages)) continue;
    const meta = storedSessionMetadata(id, raw, messages.length);
    if (opts?.cwd !== undefined && meta.cwd !== opts.cwd) continue;
    out.push(meta);
  }

  // Ties break on id so the order is total and therefore testable: two sessions
  // saved in the same millisecond must not depend on readdir order.
  out.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));

  const limit = opts?.limit;
  if (typeof limit === "number" && Number.isFinite(limit)) {
    return out.slice(0, Math.max(0, Math.floor(limit)));
  }
  return out;
}

/**
 * Incremental saved-session index for the web server.
 *
 * `listSessions` re-reads and JSON.parses every transcript (tens of MB) on each
 * call and blocks the event loop while doing so. The web sidebar polls it every
 * few seconds, so this keeps one lightweight summary per file, keyed by
 * (mtime, size, inode) from an async `stat`. A call re-parses only files whose
 * key changed, drops deleted ones, and returns exactly what `listSessions`
 * would (same filtering, ordering and shape). `saveSession` replaces files by
 * rename, so the inode changes on every write and the key cannot be fooled by
 * a same-size, same-millisecond rewrite.
 *
 * Results are additionally cached for a short TTL with in-flight coalescing, so
 * concurrent pollers share one directory scan. In-process mutations bump an
 * epoch which invalidates that result cache immediately.
 */
interface SessionIndexEntry { key: string; meta: StoredSessionMeta | null }
const sessionIndex = new Map<string, Map<string, SessionIndexEntry>>();
let sessionMutationEpoch = 0;
const LIST_RESULT_TTL_MS = 1_000;
const STAT_CONCURRENCY = 64;
const resultCache = new Map<string, { epoch: number; at: number; value: Promise<StoredSessionMeta[]> }>();

/** Counters for tests and diagnostics. */
export const sessionIndexStats = { parsed: 0, scans: 0 };

/** Drop cached summaries and results (tests, or after out-of-band edits). */
export function resetSessionIndex(): void {
  sessionIndex.clear();
  resultCache.clear();
}

async function scanSessionIndex(dir: string): Promise<Map<string, SessionIndexEntry>> {
  sessionIndexStats.scans += 1;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    sessionIndex.delete(dir);
    return new Map();
  }
  const previous = sessionIndex.get(dir) ?? new Map<string, SessionIndexEntry>();
  const next = new Map<string, SessionIndexEntry>();
  const names = entries.filter(entry => entry.endsWith(FILE_SUFFIX) && isValidSessionId(entry.slice(0, -FILE_SUFFIX.length)));
  for (let offset = 0; offset < names.length; offset += STAT_CONCURRENCY) {
    await Promise.all(names.slice(offset, offset + STAT_CONCURRENCY).map(async name => {
      const path = join(dir, name);
      let key: string;
      try {
        const stat = await fsp.stat(path, { bigint: true });
        key = `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
      } catch {
        return; // Deleted between readdir and stat.
      }
      const cached = previous.get(name);
      if (cached && cached.key === key) { next.set(name, cached); return; }
      let meta: StoredSessionMeta | null = null;
      try {
        sessionIndexStats.parsed += 1;
        const raw: unknown = JSON.parse(await fsp.readFile(path, "utf8"));
        const messages = rawValue(raw, "messages");
        if (Array.isArray(messages)) meta = storedSessionMetadata(name.slice(0, -FILE_SUFFIX.length), raw, messages.length);
      } catch { /* Unreadable or corrupt: skipped, like listSessions. */ }
      next.set(name, { key, meta });
    }));
  }
  sessionIndex.set(dir, next);
  return next;
}

/**
 * Async, index-backed equivalent of {@link listSessions}: identical output, but
 * unchanged transcripts are never re-read and the event loop is not blocked.
 */
export function listSessionsAsync(
  homeDir?: string,
  opts?: { cwd?: string; limit?: number },
): Promise<StoredSessionMeta[]> {
  const dir = sessionsDir(homeDir);
  const resultKey = JSON.stringify([dir, opts?.cwd ?? null, opts?.limit ?? null]);
  const cached = resultCache.get(resultKey);
  if (cached && cached.epoch === sessionMutationEpoch && Date.now() - cached.at < LIST_RESULT_TTL_MS) {
    return cached.value.then(rows => rows.map(row => ({ ...row })));
  }
  const epoch = sessionMutationEpoch;
  const value = (async () => {
    const index = await scanSessionIndex(dir);
    const out: StoredSessionMeta[] = [];
    for (const { meta } of index.values()) {
      if (!meta) continue;
      if (opts?.cwd !== undefined && meta.cwd !== opts.cwd) continue;
      out.push(meta);
    }
    out.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
    const limit = opts?.limit;
    return typeof limit === "number" && Number.isFinite(limit) ? out.slice(0, Math.max(0, Math.floor(limit))) : out;
  })();
  if (resultCache.size > 32) resultCache.clear();
  resultCache.set(resultKey, { epoch, at: Date.now(), value });
  // A failed scan must not stay cached for the TTL.
  value.catch(() => { if (resultCache.get(resultKey)?.value === value) resultCache.delete(resultKey); });
  return value.then(rows => rows.map(row => ({ ...row })));
}

/** Boundaries for {@link relativeAge}, kept named so the thresholds are legible. */
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
/**
 * How far into the future a `savedAt` may sit and still read as `0s` rather
 * than blank. A save and its render happen on the same clock moments apart, so
 * a few tens of seconds of disagreement is benign skew; beyond this the
 * timestamp is corrupt (a restored backup, a mis-set clock) and `relativeAge`
 * blanks it rather than fabricating an age.
 */
const FUTURE_SKEW_MS = 60_000;

/**
 * A compact "last used" age — `12s`, `5m`, `3h`, `2d`, `6w` — for the resume
 * picker to render beside a row. Pure by contract: `now` is a parameter, never
 * an ambient `Date.now()`, so a listing renders identically under test and the
 * whole store stays deterministic.
 *
 * The thresholds and the clock-skew clamp mirror the transcript's own
 * `relativeAge` (chat/TranscriptEntry.tsx) so the two age strings on screen read
 * the same, and this one simply carries the ladder further: seconds → minutes →
 * hours → days → weeks, since a resumable engagement can be far older than a
 * message inside the current turn. Weeks is the top rung on purpose — a resume
 * list that has drifted into months is a pruning problem, not a formatting one.
 *
 * A non-positive `savedAt` returns "" rather than a fabricated age: it is the
 * store's "unorderable / no timestamp" sentinel (see `toMeta`), and the caller
 * omits the separator entirely rather than printing a dangling "· ". A future
 * `savedAt` within a small skew margin ({@link FUTURE_SKEW_MS}) clamps to `0s`
 * — a few seconds of clock disagreement between save and render is normal — but
 * a `savedAt` further ahead than that is a corrupt or clock-skewed timestamp
 * (a restored backup dated in the future), so it also returns "": the picker
 * omits the age rather than claiming a misleading "0s" for a future session.
 */
export function relativeAge(savedAt: number, now: number): string {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return "";
  if (savedAt > now + FUTURE_SKEW_MS) return "";
  const seconds = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours}h`;
  const days = Math.floor(hours / HOURS_PER_DAY);
  if (days < DAYS_PER_WEEK) return `${days}d`;
  return `${Math.floor(days / DAYS_PER_WEEK)}w`;
}

/**
 * Loads one transcript, or null. Never throws: a nonexistent id, a rejected id,
 * an unreadable file and a malformed one are all the same answer to the caller
 * — "there is nothing here to resume" — which the resume UI renders as a notice
 * rather than dying on.
 */
export function loadSession(id: string, homeDir?: string): StoredSession | null {
  const path = sessionFilePath(id, homeDir);
  if (path === null) return null;
  try {
    return parseSession(id, readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Removes one transcript. Returns whether a file was actually deleted, so the
 * UI can distinguish "gone now" from "was never there" without a stat race.
 *
 * This is the operator's direct answer to "get this engagement off my disk", so
 * it must work on a file this module would refuse to *load*: a corrupt
 * transcript is still sensitive, and deletion deliberately does not parse.
 * Active and pending-resume IDs are protected even when their file is corrupt.
 */
export function deleteSession(id: string, homeDir?: string, opts?: { protectedIds?: ReadonlySet<string> }): boolean {
  if (opts?.protectedIds?.has(id)) return false;
  const path = sessionFilePath(id, homeDir);
  if (path === null) return false;
  try {
    // `force: false` is what makes the return value meaningful: a missing file
    // raises, and we report that as "nothing was deleted".
    rmSync(path, { force: false });
    return true;
  } catch {
    return false;
  } finally {
    sessionMutationEpoch += 1;
  }
}

/**
 * Caps unprotected history at the newest `keep` sessions
 * ({@link DEFAULT_PRUNE_KEEP} by default) and returns how many were removed.
 * Protected active and pending-resume IDs do not consume the archive allowance.
 *
 * Retention is a security property here, not housekeeping: without a bound, a
 * store of plaintext engagement data grows for the life of the install, and the
 * oldest entries are exactly the ones whose exposure the operator has long
 * stopped thinking about. `keep` counts across ALL working directories on
 * purpose — a per-project cap would let an operator with fifty projects
 * accumulate fifty times the intended footprint.
 *
 * A file too corrupt to list is not pruned: it is invisible to the ordering, so
 * removing it would mean deleting something we could never show the operator
 * first. `deleteSession` remains the way to get rid of those.
 */
export function pruneSessions(homeDir?: string, opts?: { keep?: number; protectedIds?: ReadonlySet<string> }): number {
  const requested = opts?.keep;
  const keep =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(0, Math.floor(requested))
      : DEFAULT_PRUNE_KEEP;

  let removed = 0;
  let archived = 0;
  for (const meta of listSessions(homeDir)) {
    if (opts?.protectedIds?.has(meta.id)) continue;
    if (archived++ < keep) continue;
    if (deleteSession(meta.id, homeDir, opts)) removed += 1;
  }
  return removed;
}

/** Archive changes presentation only; transcript and authorization stay intact. */
export function setSessionArchived(id: string, archived: boolean, homeDir?: string): boolean {
  const session = loadSession(id, homeDir);
  return session !== null && saveSession({ ...session, archived }, homeDir);
}
