import type { Finding, RuntimeMode, ScanDepth } from "@0/shared"
import type { NativeRuntime } from "../runtime/types.js";
import type { PreparedProjectContext, ProjectContextSuggestions } from "./project-context.js";

export type SecurePhase = "prepare" | "investigate" | "reproduce" | "repair" | "test" | "verify" | "deliver" | "complete";

export interface SecureEvent {
  type: "secure:phase" | "secure:finding" | "secure:repair" | "secure:complete";
  phase: SecurePhase;
  message: string;
  findingId?: string;
  data?: unknown;
}

export interface BehavioralProbeResult {
  status: "vulnerable" | "safe" | "inconclusive";
  controlsPassed: boolean;
  detail: string;
}

export interface BehavioralRepairResult {
  findingId: string;
  status: "verified" | "not_reproduced" | "not_fixed" | "blocked" | "error";
  attempts: number;
  reason?: string;
  patchPath?: string;
  patchSha256?: string;
  baseline?: BehavioralProbeResult;
  verification?: BehavioralProbeResult;
  changedFiles?: string[];
  artifactDir: string;
}


/** One recorded developer decision on a past 0sec repair for this tenant. */
export interface PriorRepairOutcome {
  category: string;
  title: string;
  outcome: "accepted" | "rejected";
  mergedAt?: string;
}

/** A reviewer's comment on a past 0sec repair PR for this tenant. */
export interface RepairGuidance {
  title: string;
  comment: string;
  author: string;
}

export interface BehavioralRepairOptions {
  repoRoot: string;
  finding: Finding;
  artifactDir: string;
  runtime: NativeRuntime;
  setupCommand?: string;
  testCommand: string;
  maxAttempts: number;
  maxTurns: number;
  timeoutMs: number;
  signal?: AbortSignal;
  projectContext?: PreparedProjectContext;
  /**
   * Developer-choice learnings: how this tenant responded to past repairs.
   * Rendered to the model as UNTRUSTED guidance (preferences, never facts
   * about the code). Cloud injects via ZERO_SECURE_PRIOR_OUTCOMES.
   */
  priorOutcomes?: PriorRepairOutcome[];
  onEvent?: (event: SecureEvent) => void;
  /** Plain-English repair standards, rendered as untrusted guidance. */
  rules?: string;
  /**
   * What human reviewers said on past repair PRs (Greptile-style comment
   * learning). Untrusted guidance. Cloud injects via ZERO_SECURE_GUIDANCE.
   */
  guidance?: RepairGuidance[];
}

export interface SecureProjectOptions {
  repoRoot: string;
  stateDir: string;
  testCommand: string;
  setupCommand?: string;
  model?: string;
  apiKey?: string;
  runtime?: RuntimeMode;
  depth?: ScanDepth;
  maxFindings?: number;
  maxAttempts?: number;
  maxTurns?: number;
  timeoutMs?: number;
  costCeilingUsd?: number;
  resume?: boolean;
  publish?: boolean;
  /**
   * Plain-English team repair standards (untrusted guidance). Defaults to the
   * ZERO_SECURE_RULES env (cloud injects per-repo rules from secure_config).
   */
  rules?: string;
  signal?: AbortSignal;
  onEvent?: (event: SecureEvent) => void;
}

export interface SecureProjectResult {
  version: 1;
  runId: string;
  status: "completed" | "blocked" | "failed" | "cancelled";
  phase: SecurePhase;
  repoRoot: string;
  revision: string;
  startedAt: string;
  completedAt?: string;
  findings: Finding[];
  repairs: BehavioralRepairResult[];
  errors: string[];
  pullRequests: string[];
  /** Real metered model cost (USD) from provider-reported usage; 0 when the
   *  runtime surfaces no usage. Never an estimate. */
  costUsd: number;
  projectContextSuggestions?: ProjectContextSuggestions;
}