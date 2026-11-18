export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  createConsoleSession,
  createConsoleRuntime,
  buildConsoleSystemPrompt,
  isDangerousLocalRoot,
} from "./turn-engine.js";
export {
  AUTO_TITLE_TIMEOUT_MS,
  fallbackConversationTitle,
  firstExchange,
  generateConversationTitle,
  inferTitleSource,
  titleSystemPrompt,
  isDefaultConversationTitle,
  redactForTitle,
  sanitizeGeneratedTitle,
} from "./auto-title.js";
export type { AutoTitleInput, AutoTitleResult, ConversationTitleSource } from "./auto-title.js";
export type {
  ConsoleConversationHistory,
  ConsoleSession,
  ConsoleSourceContext,
  ConsoleSourceLesson,
  ConsoleSessionConfig,
  ConsoleRenderCallbacks,
  ConsoleCompactionEvent,
  ConsoleTurnOutcome,
  ConsoleStopReason,
  ConsoleTurnBudget,
  ConsoleUsageReport,
} from "./turn-engine.js";
export type { ConsoleSessionCheckpoint } from "./session-checkpoint.js";
export {
  deriveObjectiveHeuristic,
  createSessionObjectiveService,
  MAX_OBJECTIVE_CHARS,
  MAX_OBJECTIVE_WORDS,
} from "./session-objective.js";
export type {
  SessionObjectiveService,
  SessionObjectiveServiceConfig,
} from "./session-objective.js";
