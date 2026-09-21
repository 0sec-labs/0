// Extracted verbatim from agentic-scanner.ts (S3 cleanup, pure relocation — no logic changes).
import type { ScanConfig, Finding, LayerVerdict, PocStep } from "@0/shared";
import { resolveIdentities } from "@0/shared";
import { runAgentLoop } from "../agent/loop.js";
import { runNativeAgentLoop } from "../agent/native-loop.js";
import { toolCallPreview } from "../agent/tool-preview.js";
import { getToolsForRole, TOOL_DEFINITIONS, parsePocStepsArg } from "../agent/tools.js";
import {
  discoveryPrompt,
  attackPrompt,
  verifyPrompt,
  verifyPromptSingleFinding,
  webPentestDiscoveryPrompt,
  webPentestAttackPrompt,
  shellPentestPrompt,
  buildAccessControlPromptBlock,
} from "../agent/prompts.js";
import { createScanMemoryStore } from "../triage/memories.js";
import { features } from "../agent/features.js";
import { diag } from "../diagnostics/channel.js";
import type { ScanListener } from "../scanner.js";
import type { NativeRuntime, NativeMessage } from "../runtime/types.js";
import type { ToolCall } from "../agent/types.js";
import { z } from "zod";
import { layerVerdictArraySchema, formatZodError } from "../schemas.js";
import { parseImpactAssessment } from "../triage/impact-assessment.js";
import {
  getOrCreateRateLimiter,
  resolveEngagementForConfig,
  resolveEnforcementForConfig,
  resolveScopeForConfig,
  buildAttributionForConfig,
} from "./scan-config.js";
import { verify } from "../triage/structured-verify.js";
import { getCloudSinkConfig, postFinding } from "../cloud-sink.js";
import { splitCost } from "../agent/cost.js";
import { EnforcementTracker } from "../scope/enforcement.js";

// ── Shared state type for agent outputs ──

export interface AgentOutput {
  findings: Finding[];
  targetInfo: Partial<import("@0/shared").TargetInfo>;
  summary: string;
  turnCount: number;
  estimatedCostUsd: number;
  /**
   * Raw token-usage tally from the loop state. Surfaced separately
   * from `estimatedCostUsd` so the `scan_completed` event payload
   * can build per-(provider, model) cost splits via `splitCost()`
   * (0#231) instead of just emitting a fused dollar total.
   * Optional for back-compat with legacy CLI runtimes that don't
   * report tokens.
   */
  totalUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  /** True when this stage terminated because the cost ceiling was hit. */
  costCeilingExceeded?: boolean;
  /**
   * Set when the agent loop bailed because the planner LLM returned an
   * error (or empty response). Propagated up from `NativeAgentState.errorExit`
   * so the top-level scan can flip `exit_reason` from "completed" to "failed"
   * — the legacy `summary` field still carries the raw "Error: ..." marker
   * for back-compat with older readers.
   */
  errorExit?: { error: string; turn: number };
  /** Full conversation trace (messages) from the agent loop. */
  messages?: NativeMessage[];
}

// ── Native (Claude API) stage runners ──


export async function runNativeDiscovery(
  runtime: NativeRuntime,
  db: any,
  config: ScanConfig,
  scanId: string,
  emit: ScanListener,
  apiSpecPromptText?: string,
  getPendingUserMessages?: () => string[],
): Promise<AgentOutput> {
  // http_audit reuses the web-pentest prompts + tools wholesale; the only
  // additions are the env-driven scope/path/rate/kill enforcement layered on
  // via the EnforcementTracker. So it is "web" for every prompt/tool decision.
  const isWeb = config.mode === "web" || config.mode === "http_audit";
  // Multi-identity access-control testing (0#564): reconcile legacy
  // `auth` with `identities` and surface the access_control_probe guidance.
  const identities = resolveIdentities(config);
  const basePrompt = isWeb
    ? webPentestDiscoveryPrompt(config.target, config.auth) + buildAccessControlPromptBlock(identities)
    : discoveryPrompt(config.target, config.auth) + buildAccessControlPromptBlock(identities);
  let systemPrompt = apiSpecPromptText
    ? basePrompt + "\n\n" + apiSpecPromptText
    : basePrompt;
  const tools = isWeb
    ? getToolsForRole("discovery", { webMode: true, allowScanners: config.allowScanners })
    : getToolsForRole("discovery", { allowScanners: config.allowScanners });

  // NOTE: the deterministic web-recon pre-pass runs once on the COMMON discovery
  // path in agenticScan (so it covers both native and legacy/codex runtimes) —
  // not here. Its leads arrive via apiSpecPromptText, injected into systemPrompt above.

  const state = await runNativeAgentLoop({
    config: {
      role: "discovery",
      systemPrompt,
      tools,
      maxTurns: isWeb ? 12 : 8,
      target: config.target,
      scanId,
      sessionId: db.getSession(scanId, "discovery")?.id,
      authConfig: config.auth,
      identities,
      scope: resolveScopeForConfig(config),
      rateLimiter: getOrCreateRateLimiter(config),
      enforcement: resolveEnforcementForConfig(config),
      allowScanners: config.allowScanners,
      attribution: buildAttributionForConfig(config),
      engagement: resolveEngagementForConfig(config),
      costCeilingUsd: config.costCeilingUsd,
      costModel: config.model,
    },
    runtime,
    db,
    getPendingUserMessages,
    onEvent: (eventType, payload) => {
      if (eventType === "user:injected") {
        emit({ type: "user:injected", stage: "discovery", message: String(payload.text ?? ""), data: payload });
      }
    },
    onTurn: (turn, toolCalls) => {
      // One sub-action per tool call with a real preview of what the tool
      // was invoked with — e.g. `turn 3: bash: curl -sI https://t/admin`
      // instead of a useless `turn 3: bash`. Uses `stage:start` (not
      // `stage:end`) because the stage is still running; `stage:end` would
      // prematurely mark Discover as ✓ done every turn, which was the exact
      // bug we carried pre-0.7.7.
      if (toolCalls.length === 0) {
        emit({ type: "stage:start", stage: "discovery", message: `turn ${turn}: thinking` });
      } else {
        for (const call of toolCalls) {
          emit({
            type: "stage:start",
            stage: "discovery",
            message: `turn ${turn}: ${toolCallPreview(call)}`,
          });
        }
      }
    },
  });
  return {
    findings: state.findings,
    targetInfo: state.targetInfo,
    summary: state.summary,
    turnCount: state.turnCount,
    estimatedCostUsd: state.estimatedCostUsd,
    totalUsage: state.totalUsage,
    errorExit: state.errorExit,
    messages: state.messages,
  };
}

export async function runNativeAttack(
  runtime: NativeRuntime,
  db: any,
  config: ScanConfig,
  scanId: string,
  targetInfo: Partial<import("@0/shared").TargetInfo>,
  categories: string[],
  maxTurns: number,
  emit: ScanListener,
  challengeHint?: string,
  apiSpecPromptText?: string,
  getPendingUserMessages?: () => string[],
): Promise<AgentOutput> {
  // http_audit reuses the web-pentest prompts + tools wholesale; the only
  // additions are the env-driven scope/path/rate/kill enforcement layered on
  // via the EnforcementTracker. So it is "web" for every prompt/tool decision.
  const isWeb = config.mode === "web" || config.mode === "http_audit";

  // Detect playwright availability for browser tool
  let hasBrowser = false;
  // @ts-ignore — playwright is an optional dependency
  try { await import("playwright"); hasBrowser = true; } catch { /* playwright not installed */ }

  // Shell-first for web targets: minimal tool set (bash + save_finding + done)
  // White-box mode: add read_file + run_command when source code path is provided
  const hasSource = !!config.repoPath;
  const identities = resolveIdentities(config);
  let basePrompt = isWeb
    ? shellPentestPrompt(config.target, config.repoPath, { hasBrowser, auth: config.auth })
    : attackPrompt(config.target, targetInfo, categories, config.auth);
  basePrompt += buildAccessControlPromptBlock(identities);
  // Inject API spec knowledge if available
  if (apiSpecPromptText) basePrompt += "\n\n" + apiSpecPromptText;

  // Pre-recon CVE check (white-box mode only). Walk the source tree,
  // run `npm audit` / `pip-audit` against any detected manifests, and
  // surface high/critical advisories as priority leads in the system
  // prompt. Defends against expensive thrash on CVE-tagged challenges
  // like XBEN-030 / XBEN-034 where the agent had source access but no
  // concrete leads and burned $6+ producing 0 findings.
  // Gated behind ZERO_FEATURE_PRE_RECON_CVE (default ON in white-box).
  let preReconBlock = "";
  if (hasSource && config.repoPath && features.preReconCve) {
    try {
      const { runPreReconCveCheck, formatPreReconForPrompt } = await import(
        "../pre-recon-cve.js"
      );
      const report = runPreReconCveCheck(config.repoPath);
      const formatted = formatPreReconForPrompt(report);
      if (formatted) {
        preReconBlock = "\n\n" + formatted;
        emit({
          type: "stage:end",
          stage: "discovery",
          message: `Pre-recon CVE check: ${report.advisories.length} high/critical advisor${report.advisories.length === 1 ? "y" : "ies"} across ${report.manifestsScanned.length} manifest${report.manifestsScanned.length === 1 ? "" : "s"} (${report.durationMs}ms)`,
        });
      }
    } catch (err) {
      // Pre-recon must never break the scan
      diag.warn("pre_recon_cve_failed", "pre-recon CVE check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase-4 WordPress pre-recon. Runs three cheap probes against the
  // target; if WP is detected, invokes runWpFingerprint directly (not
  // via the agent loop) and folds the structured CVE leads into the
  // system prompt alongside the source-tree CVE block above. Gated by
  // the `wpFingerprint` feature flag so it stays off in runs where
  // network egress is not wanted. See GitHub issue #83.
  if (isWeb && features.wpFingerprint) {
    try {
      const { runPreReconWordPress, formatPreReconWordPressForPrompt } =
        await import("../pre-recon-cve.js");
      const wpReport = await runPreReconWordPress({
        target: config.target,
      });
      if (wpReport.isWordPress && wpReport.fingerprint) {
        const formatted = formatPreReconWordPressForPrompt(wpReport);
        if (formatted) {
          preReconBlock += "\n\n" + formatted;
          const pluginCount = wpReport.fingerprint.plugins.length;
          const cveCount = wpReport.fingerprint.findings.reduce(
            (sum, f) => sum + f.cves.length,
            0,
          );
          emit({
            type: "stage:end",
            stage: "discovery",
            message: `Pre-recon WordPress: ${pluginCount} plugin${pluginCount === 1 ? "" : "s"} enumerated, ${cveCount} CVE hit${cveCount === 1 ? "" : "s"} (${wpReport.durationMs}ms)`,
          });
        }
      }
    } catch (err) {
      diag.warn("pre_recon_wordpress_failed", "pre-recon WordPress probe failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Append challenge hint if provided (standard practice for XBOW benchmarks)
  const systemPrompt =
    (challengeHint ? basePrompt + "\n" + challengeHint : basePrompt) + preReconBlock;

  const shellToolNames = hasSource
    ? [
        "bash",
        ...(hasBrowser ? ["browser"] : []),
        "payload_lookup",
        ...(features.wpFingerprint ? ["wp_fingerprint"] : []),
        ...(features.mongoObjectIdForge ? ["mongo_objectid"] : []),
        ...(features.jitSkills ? ["list_skills", "load_skill"] : []),
        "read_file",
        "run_command",
        "spawn_agent",
        "spawn_agents",
        "spawn_persistent_agent",
        "save_finding",
        "done",
      ]
    : [
        "bash",
        ...(hasBrowser ? ["browser"] : []),
        "payload_lookup",
        ...(features.wpFingerprint ? ["wp_fingerprint"] : []),
        ...(features.mongoObjectIdForge ? ["mongo_objectid"] : []),
        ...(features.jitSkills ? ["list_skills", "load_skill"] : []),
        "spawn_agent",
        "spawn_agents",
        "spawn_persistent_agent",
        "save_finding",
        "done",
      ];
  const shellTools: import("../agent/types.js").ToolDefinition[] = shellToolNames
    .map((n) => TOOL_DEFINITIONS[n])
    .filter((t): t is import("../agent/types.js").ToolDefinition => t !== undefined);

  // A white-box SOURCE review (repoPath set, no live web/http target) is a
  // code audit, not a network/LLM pentest: give it the source-scoped tool set
  // (read_file/run_command/bash — no send_prompt/http_request), the same set an
  // isWeb white-box run already gets. Previously a source-only run (isWeb=false,
  // hasSource=true — every seedless `deep_review` finder/verify) fell through to
  // the full "attack" role, which hands it the live-target LLM/web attack tools
  // (send_prompt, http_request). On repos with no such surface the finder burned
  // its turns probing for prompt-injection / SSO-federation instead of auditing
  // code, then found nothing. Scoping the toolset removes that drift.
  const tools = (isWeb || hasSource) ? shellTools : getToolsForRole("attack", { hasBrowser, allowScanners: config.allowScanners });

  const effectiveMaxTurns =
    isWeb && config.maxAttackTurns === undefined ? Math.max(maxTurns, 15) : maxTurns;

  const cloudSinkCfg = getCloudSinkConfig();
  const onTurnHandler = (turn: number, toolCalls: ToolCall[]) => {
    // One sub-action per tool call with a full preview (tool + first-order
    // argument) so the verbose TUI can show what the attack agent is
    // actually running on each turn — e.g. `turn 7: bash: nmap -sV t.com`
    // instead of `turn 7: bash`. Compact view still clips to last 3.
    if (toolCalls.length === 0) {
      emit({ type: "stage:start", stage: "attack", message: `turn ${turn}: thinking` });
    } else {
      for (const call of toolCalls) {
        emit({
          type: "stage:start",
          stage: "attack",
          message: `turn ${turn}: ${toolCallPreview(call)}`,
        });
      }
    }
  };

  // First attempt: give the full budget. The loop's early-stop logic will
  // bail at 50% if no save_finding has been called (retryCount=0 enables this).
  const state = await runNativeAgentLoop({
    config: {
      role: "attack",
      systemPrompt,
      tools,
      maxTurns: effectiveMaxTurns,
      target: config.target,
      scanId,
      scopePath: config.repoPath,
      sessionId: db.getSession(scanId, "attack")?.id,
      retryCount: 0,
      authConfig: config.auth,
      identities,
      scope: resolveScopeForConfig(config),
      rateLimiter: getOrCreateRateLimiter(config),
      enforcement: resolveEnforcementForConfig(config),
      allowScanners: config.allowScanners,
      attribution: buildAttributionForConfig(config),
      engagement: resolveEngagementForConfig(config),
      costCeilingUsd: config.costCeilingUsd,
      costModel: config.model,
    },
    runtime,
    db,
    getPendingUserMessages,
    onEvent: (eventType, payload) => {
      if (eventType === "user:injected") {
        emit({ type: "user:injected", stage: "attack", message: String(payload.text ?? ""), data: payload });
      }
    },
    onFindingSaved: (finding) => {
      emit({
        type: "finding",
        message: `[${finding.severity}] ${finding.title}`,
        data: finding,
      });
      void postFinding(finding, cloudSinkCfg);
    },
    onTurn: onTurnHandler,
  });

  // ── Early-stop retry: if no findings by halfway, retry with a different strategy ──
  if (features.earlyStopRetry && state.earlyStopNoProgress) {
    const remainingBudget = effectiveMaxTurns - state.turnCount;

    emit({
      type: "stage:start",
      stage: "attack",
      message: `No findings after ${state.turnCount} turns — retrying with different strategy (${remainingBudget} turns remaining)...`,
    });

    db.logEvent?.({
      scanId,
      stage: "attack",
      eventType: "early_stop_retry",
      agentRole: "attack",
      payload: {
        firstAttemptTurns: state.turnCount,
        remainingBudget,
        attemptSummary: state.attemptSummary,
      },
      timestamp: Date.now(),
    });

    // Build structured progress handoff: prefer LLM-generated summary from
    // the agent loop (richer context, captures reasoning), fall back to regex
    // extraction if the LLM summary wasn't generated.
    let progressSection = "";
    if (features.progressHandoff) {
      if (state.progressSummary) {
        progressSection = `## Previous Attempt — Structured Progress\n\n${state.progressSummary}`;
      } else {
        progressSection = formatProgressHandoff(extractProgressFromAttempt(state.messages));
      }
    }

    const retrySystemPrompt = systemPrompt + `\n\n## RETRY — Previous Attempt Failed\n\nA previous attack attempt used ${state.turnCount} turns and found NOTHING.\n${state.attemptSummary}\n${progressSection}\nYou MUST try a COMPLETELY DIFFERENT approach:\n- Different entry points and endpoints\n- Different vulnerability classes (if SQLi failed, try SSTI/command injection/SSRF/path traversal)\n- Different tools and techniques (if curl failed, try Python scripts; if GET failed, try POST)\n- Different encoding and bypass techniques\n- Look for indirect/second-order vulnerabilities\n\nDo NOT repeat the same strategies. Be creative and aggressive.`;

    const retryState = await runNativeAgentLoop({
      config: {
        role: "attack",
        systemPrompt: retrySystemPrompt,
        tools,
        maxTurns: remainingBudget,
        target: config.target,
        scanId,
        scopePath: config.repoPath,
        retryCount: 1,
        authConfig: config.auth,
        identities,
        scope: resolveScopeForConfig(config),
        rateLimiter: getOrCreateRateLimiter(config),
        enforcement: resolveEnforcementForConfig(config),
      allowScanners: config.allowScanners,
      attribution: buildAttributionForConfig(config),
      engagement: resolveEngagementForConfig(config),
        costCeilingUsd: config.costCeilingUsd,
        costModel: config.model,
      },
      runtime,
      db,
      getPendingUserMessages,
      onEvent: (eventType, payload) => {
        if (eventType === "user:injected") {
          emit({ type: "user:injected", stage: "attack", message: String(payload.text ?? ""), data: payload });
        }
      },
      onTurn: onTurnHandler,
    });

    // Merge results from both attempts
    const combinedFindings = [...state.findings, ...retryState.findings];
    const totalTurns = state.turnCount + retryState.turnCount;
    const combinedSummary = retryState.findings.length > 0
      ? retryState.summary
      : `First attempt (${state.turnCount} turns): no findings. Retry (${retryState.turnCount} turns): ${retryState.summary}`;

    return {
      findings: combinedFindings,
      targetInfo: { ...state.targetInfo, ...retryState.targetInfo },
      summary: combinedSummary,
      turnCount: totalTurns,
      estimatedCostUsd: state.estimatedCostUsd + retryState.estimatedCostUsd,
      // The native-loop's state.totalUsage today only carries
      // input/output (no cachedInputTokens). When the runtime starts
      // tracking cache reads (likely via a separate runtime-level
      // hook), this merge will need to fold that field in too.
      totalUsage: {
        inputTokens:
          (state.totalUsage?.inputTokens ?? 0) +
          (retryState.totalUsage?.inputTokens ?? 0),
        outputTokens:
          (state.totalUsage?.outputTokens ?? 0) +
          (retryState.totalUsage?.outputTokens ?? 0),
      },
      costCeilingExceeded: state.costCeilingExceeded || retryState.costCeilingExceeded,
      // If either attempt bailed on a planner error, surface the latest
      // one (retry takes precedence — it ran most recently).
      errorExit: retryState.errorExit ?? state.errorExit,
      messages: [...state.messages, ...retryState.messages],
    };
  }

  // First attempt completed normally (found something, or exhausted turns).
  // No retry needed.
  return {
    findings: state.findings,
    targetInfo: state.targetInfo,
    summary: state.summary,
    turnCount: state.turnCount,
    estimatedCostUsd: state.estimatedCostUsd,
    totalUsage: state.totalUsage,
    costCeilingExceeded: state.costCeilingExceeded,
    errorExit: state.errorExit,
    messages: state.messages,
  };
}

// ── Progress Handoff: extract structured findings from a failed attempt's conversation ──

interface AttemptProgress {
  endpoints: string[];
  credentials: string[];
  technologies: string[];
  attacksTried: string[];
}

/**
 * Regex-extract structured progress from the first attempt's messages.
 * No LLM call — pure pattern matching on tool results.
 */
function extractProgressFromAttempt(messages: NativeMessage[]): AttemptProgress {
  const endpoints = new Set<string>();
  const credentials = new Set<string>();
  const technologies = new Set<string>();
  const attacksTried = new Set<string>();

  // Patterns
  const urlPattern = /https?:\/\/[^\s"'<>)\]}{,]+/g;
  const credPatterns = [
    /(?:login|username|user|email)[\s:="']+([^\s"'<>,;}{)(\]]{2,60})/gi,
    /(?:password|passwd|pass|pwd)[\s:="']+([^\s"'<>,;}{)(\]]{2,60})/gi,
    /(?:token|cookie|session[_-]?id|api[_-]?key|bearer|jwt|authorization)[\s:="']+([^\s"'<>,;}{)(\]]{2,80})/gi,
  ];
  const techPatterns = [
    /(?:server|x-powered-by|x-framework):\s*([^\r\n]+)/gi,
    /(?:express|flask|django|rails|spring|laravel|next\.?js|fastapi|gin|fiber|sinatra|koa)/gi,
    /(?:mysql|postgres(?:ql)?|sqlite|mongodb|redis|mariadb)/gi,
    /(?:php|python|ruby|node(?:\.?js)?|java|golang|go|rust|\.net)/gi,
  ];
  const curlPattern = /curl\s+[^\n]{10,}/g;

  for (const msg of messages) {
    for (const block of msg.content) {
      let text = "";
      if (block.type === "tool_result") {
        text = block.content;
      } else if (block.type === "text") {
        text = block.text;
      } else if (block.type === "tool_use") {
        // Extract curl commands from shell_exec / run_command arguments
        const input = block.input as Record<string, unknown>;
        const cmd = (input.command ?? input.cmd ?? "") as string;
        if (cmd) text = cmd;
        // Also capture the URL from http_request tool
        const url = (input.url ?? "") as string;
        if (url) endpoints.add(url);
      }

      if (!text) continue;

      // Extract URLs/endpoints
      for (const match of text.matchAll(urlPattern)) {
        const u = match[0].replace(/[.,;:!?)}\]]+$/, ""); // strip trailing punctuation
        if (u.length < 200) endpoints.add(u);
      }

      // Extract credentials
      for (const pattern of credPatterns) {
        for (const match of text.matchAll(pattern)) {
          const full = match[0].trim();
          if (full.length < 200) credentials.add(full);
        }
      }

      // Extract technologies
      for (const pattern of techPatterns) {
        for (const match of text.matchAll(pattern)) {
          const tech = (match[1] ?? match[0]).trim();
          if (tech.length < 100) technologies.add(tech);
        }
      }

      // Extract curl commands (as attacks tried)
      for (const match of text.matchAll(curlPattern)) {
        const cmd = match[0].trim();
        if (cmd.length < 300) attacksTried.add(cmd);
      }
    }
  }

  return {
    endpoints: [...endpoints].slice(0, 30),
    credentials: [...credentials].slice(0, 20),
    technologies: [...technologies].slice(0, 15),
    attacksTried: [...attacksTried].slice(0, 25),
  };
}

/** Format extracted progress into a section for the retry system prompt. */
function formatProgressHandoff(progress: AttemptProgress): string {
  const sections: string[] = ["## Previous Attempt Summary", ""];

  if (progress.endpoints.length > 0) {
    sections.push("### URLs/Endpoints Discovered");
    for (const ep of progress.endpoints) sections.push(`- ${ep}`);
    sections.push("");
  }

  if (progress.credentials.length > 0) {
    sections.push("### Credentials / Tokens Found");
    for (const c of progress.credentials) sections.push(`- ${c}`);
    sections.push("");
  }

  if (progress.technologies.length > 0) {
    sections.push("### Technologies Identified");
    for (const t of progress.technologies) sections.push(`- ${t}`);
    sections.push("");
  }

  if (progress.attacksTried.length > 0) {
    sections.push("### Attacks Already Tried (do NOT repeat these)");
    for (const a of progress.attacksTried) sections.push(`- \`${a}\``);
    sections.push("");
  }

  // Only return if we actually extracted something useful
  const hasContent = progress.endpoints.length > 0
    || progress.credentials.length > 0
    || progress.technologies.length > 0
    || progress.attacksTried.length > 0;

  return hasContent ? sections.join("\n") : "";
}

/** Format targetInfo from the discovery stage into a human-readable summary for the web attack prompt. */
function formatWebDiscoveryInfo(targetInfo: Partial<import("@0/shared").TargetInfo>): string {
  const parts: string[] = [];
  if (targetInfo.type) parts.push(`Type: ${targetInfo.type}`);
  if (targetInfo.model) parts.push(`Server/Framework: ${targetInfo.model}`);
  if (targetInfo.endpoints?.length) {
    parts.push(`Discovered endpoints:\n${targetInfo.endpoints.map((e) => `  - ${e}`).join("\n")}`);
  }
  if (targetInfo.detectedFeatures?.length) {
    parts.push(`Features: ${targetInfo.detectedFeatures.join(", ")}`);
  }
  if (targetInfo.systemPrompt) {
    parts.push(`Additional info: ${targetInfo.systemPrompt.slice(0, 1000)}`);
  }
  return parts.length > 0 ? parts.join("\n") : "No prior discovery information available. Start by crawling the target.";
}

/**
 * Per-finding verify budget. Reference: `pov-gate.ts:367 buildPovSystemPrompt`
 * runs one-finding-per-agent-session with a tight 5-turn cap; mirroring that
 * here ensures one runaway finding can't burn the whole verify pass.
 *
 * Background (from #285 — control-flow audit H2): the previous implementation
 * passed every finding into a single `runNativeAgentLoop` with
 * `maxTurns: Math.min(findings.length * 3, 15)`. With ≥6 findings the model
 * silently skipped, deduped, or condensed, producing under-coverage that's
 * invisible in benchmarks.
 */
const VERIFY_TURNS_PER_FINDING = 5;

export async function runNativeVerify(
  runtime: NativeRuntime,
  db: any,
  config: ScanConfig,
  scanId: string,
  findings: Finding[],
  emit: ScanListener,
): Promise<void> {
  // Per-finding verify loop (#285). One agent session per finding so each
  // gets its own turn budget — N findings → N runtime calls, never a shared
  // pool the model can starve from.
  const memoryStore = db ? createScanMemoryStore(db) : undefined;
  for (const finding of findings) {
    let memoryContext = "";
    if (memoryStore) {
      try {
        memoryContext = await memoryStore.formatForPrompt(await memoryStore.getRelevantMemories(finding, config.target));
      } catch { /* Historical context never replaces independent verification. */ }
    }
    await runNativeAgentLoop({
      config: {
        role: "verify",
        systemPrompt: verifyPromptSingleFinding(config.target, finding, config.auth) + "\n\n" + memoryContext,
        tools: getToolsForRole("verify", { hasScope: !!config.repoPath, allowScanners: config.allowScanners }),
        maxTurns: VERIFY_TURNS_PER_FINDING,
        target: config.target,
        scanId,
        sessionId: db?.getSession?.(scanId, "verify")?.id,
        authConfig: config.auth,
        identities: resolveIdentities(config),
        scope: resolveScopeForConfig(config),
        rateLimiter: getOrCreateRateLimiter(config),
        enforcement: resolveEnforcementForConfig(config),
        allowScanners: config.allowScanners,
        attribution: buildAttributionForConfig(config),
        engagement: resolveEngagementForConfig(config),
        costCeilingUsd: config.costCeilingUsd,
        costModel: config.model,
      },
      runtime,
      db,
      onTurn: (turn, toolCalls) => {
        // One sub-action per tool call with a full preview, matching the
        // discovery and attack handlers. Without this the verify stage is
        // completely silent in the TUI, even under verbose mode.
        if (toolCalls.length === 0) {
          emit({
            type: "stage:start",
            stage: "verify",
            message: `[${finding.id}] turn ${turn}: thinking`,
          });
        } else {
          for (const call of toolCalls) {
            emit({
              type: "stage:start",
              stage: "verify",
              message: `[${finding.id}] turn ${turn}: ${toolCallPreview(call)}`,
            });
          }
        }
      },
    });
  }
}

// ── Legacy (text-based) stage runners ──

export async function runLegacyDiscovery(
  runtime: import("../runtime/types.js").Runtime,
  db: any,
  config: ScanConfig,
  scanId: string,
  emit: ScanListener,
  dbPath?: string,
  apiSpecPromptText?: string,
): Promise<AgentOutput> {
  // http_audit reuses the web-pentest prompts + tools wholesale; the only
  // additions are the env-driven scope/path/rate/kill enforcement layered on
  // via the EnforcementTracker. So it is "web" for every prompt/tool decision.
  const isWeb = config.mode === "web" || config.mode === "http_audit";
  const identities = resolveIdentities(config);
  const basePrompt =
    (isWeb
      ? webPentestDiscoveryPrompt(config.target, config.auth)
      : discoveryPrompt(config.target, config.auth)) + buildAccessControlPromptBlock(identities);
  const systemPrompt = apiSpecPromptText
    ? basePrompt + "\n\n" + apiSpecPromptText
    : basePrompt;
  const tools = isWeb
    ? getToolsForRole("discovery", { webMode: true, allowScanners: config.allowScanners })
    : getToolsForRole("discovery", { allowScanners: config.allowScanners });

  const state = await runAgentLoop({
    config: {
      role: "discovery",
      systemPrompt,
      tools,
      maxTurns: isWeb ? 12 : 8,
      target: config.target,
      scanId,
      sessionId: db?.getSession(scanId, "discovery")?.id,
      attachTargetToolsMcp: true,
      dbPath,
      authConfig: config.auth,
      identities,
      scope: resolveScopeForConfig(config),
      rateLimiter: getOrCreateRateLimiter(config),
      enforcement: resolveEnforcementForConfig(config),
      allowScanners: config.allowScanners,
      attribution: buildAttributionForConfig(config),
      engagement: resolveEngagementForConfig(config),
      dispatchMode: config.dispatchMode,
      modelHint: config.model,
    },
    runtime,
    db,
    onTurn: (turn, msg) => {
      // Sub-action while the stage is still running — must be `stage:start`,
      // not `stage:end`, or the UI marks Discover as ✓ done every turn.
      const preview = msg.content.replace(/\s+/g, " ").trim().slice(0, 100);
      emit({
        type: "stage:start",
        stage: "discovery",
        message: `turn ${turn}: ${preview}`,
      });
    },
  });
  return {
    findings: state.findings,
    targetInfo: state.targetInfo,
    summary: state.summary,
    turnCount: state.turnCount,
    estimatedCostUsd: 0, // Legacy runtime does not track token usage
  };
}

export async function runLegacyAttack(
  runtime: import("../runtime/types.js").Runtime,
  db: any,
  config: ScanConfig,
  scanId: string,
  targetInfo: Partial<import("@0/shared").TargetInfo>,
  categories: string[],
  maxTurns: number,
  emit: ScanListener,
  dbPath?: string,
  apiSpecPromptText?: string,
): Promise<AgentOutput> {
  // http_audit reuses the web-pentest prompts + tools wholesale; the only
  // additions are the env-driven scope/path/rate/kill enforcement layered on
  // via the EnforcementTracker. So it is "web" for every prompt/tool decision.
  const isWeb = config.mode === "web" || config.mode === "http_audit";

  // Detect playwright availability for browser tool (mirrors native path)
  let hasBrowser = false;
  // @ts-ignore — playwright is an optional dependency
  try { await import("playwright"); hasBrowser = true; } catch { /* playwright not installed */ }

  const identities = resolveIdentities(config);
  let baseAttackPrompt = isWeb
    ? webPentestAttackPrompt(config.target, formatWebDiscoveryInfo(targetInfo), config.auth)
    : attackPrompt(config.target, targetInfo, categories, config.auth);
  baseAttackPrompt += buildAccessControlPromptBlock(identities);
  if (apiSpecPromptText) baseAttackPrompt += "\n\n" + apiSpecPromptText;
  const systemPrompt = baseAttackPrompt;
  const tools = isWeb
    ? getToolsForRole("attack", { webMode: true, hasBrowser, allowScanners: config.allowScanners })
    : getToolsForRole("attack", { hasBrowser, allowScanners: config.allowScanners });

  const cloudSinkCfg = getCloudSinkConfig();
  const effectiveMaxTurns =
    isWeb && config.maxAttackTurns === undefined ? Math.max(maxTurns, 25) : maxTurns;
  const state = await runAgentLoop({
    config: {
      role: "attack",
      systemPrompt,
      tools,
      maxTurns: effectiveMaxTurns,
      target: config.target,
      scanId,
      sessionId: db?.getSession(scanId, "attack")?.id,
      attachTargetToolsMcp: true,
      dbPath,
      identities,
      authConfig: config.auth,
      scope: resolveScopeForConfig(config),
      rateLimiter: getOrCreateRateLimiter(config),
      enforcement: resolveEnforcementForConfig(config),
      allowScanners: config.allowScanners,
      attribution: buildAttributionForConfig(config),
      engagement: resolveEngagementForConfig(config),
      dispatchMode: config.dispatchMode,
      modelHint: config.model,
    },
    runtime,
    db,
    onTurn: (turn, msg) => {
      const calls = msg.toolCalls ?? [];
      // One sub-action per tool call with a full preview (tool + first-
      // order argument), same as the native-API path. Previously this
      // handler only emitted finding events; the verbose TUI showed an
      // empty actions list between finding discoveries.
      if (calls.length === 0) {
        emit({ type: "stage:start", stage: "attack", message: `turn ${turn}: thinking` });
      } else {
        for (const call of calls) {
          emit({
            type: "stage:start",
            stage: "attack",
            message: `turn ${turn}: ${toolCallPreview(call)}`,
          });
        }
      }
    },
    onFindingSaved: (finding) => {
      emit({
        type: "finding",
        message: `[${finding.severity}] ${finding.title}`,
        data: finding,
      });
      void postFinding(finding, cloudSinkCfg);
    },
  });
  return {
    findings: state.findings,
    targetInfo: state.targetInfo,
    summary: state.summary,
    turnCount: state.turnCount,
    estimatedCostUsd: 0, // Legacy runtime does not track token usage
  };
}

export async function runLegacyVerify(
  runtime: import("../runtime/types.js").Runtime,
  db: any,
  config: ScanConfig,
  scanId: string,
  findings: Finding[],
  _emit: ScanListener,
  dbPath?: string,
): Promise<void> {
  await runAgentLoop({
    config: {
      role: "verify",
      systemPrompt: verifyPrompt(config.target, findings, config.auth),
      tools: getToolsForRole("verify", { hasScope: !!config.repoPath, allowScanners: config.allowScanners }),
      maxTurns: Math.min(findings.length * 3, 15),
      target: config.target,
      scanId,
      sessionId: db?.getSession(scanId, "verify")?.id,
      attachTargetToolsMcp: true,
      dbPath,
      authConfig: config.auth,
      identities: resolveIdentities(config),
      scope: resolveScopeForConfig(config),
      rateLimiter: getOrCreateRateLimiter(config),
      enforcement: resolveEnforcementForConfig(config),
      allowScanners: config.allowScanners,
      attribution: buildAttributionForConfig(config),
      engagement: resolveEngagementForConfig(config),
      dispatchMode: config.dispatchMode,
      modelHint: config.model,
    },
    runtime,
    db,
  });
}

// ── Helper: convert DB finding row to Finding type ──

export function dbFindingToFinding(dbf: {
  id: string;
  templateId: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  status: string;
  confidence: number | null;
  cvssVector: string | null;
  cvssScore: number | null;
  evidenceRequest: string;
  evidenceResponse: string;
  evidenceAnalysis: string | null;
  pocSteps?: string | null;
  layerVerdicts?: string | null;
  impactAssessment?: string | null;
  semanticDedupe?: string | null;
  findingRank?: number | null;
  timestamp: number;
}): Finding {
  let layerVerdicts: LayerVerdict[] | undefined;
  if (dbf.layerVerdicts) {
    try {
      // Validated parse: zod enforces the LayerVerdict shape so a corrupt or
      // legacy DB row can't silently leak a malformed verdict into the
      // hydrated Finding (which would surface as a deep TypeError when the
      // dashboard / dynamic-routing model touches verdict.changedSeverity
      // or verdict.confidence). Schema `.passthrough()`s unknown fields so
      // newer telemetry columns keep round-tripping.
      const parsed: unknown = JSON.parse(dbf.layerVerdicts);
      const validated = layerVerdictArraySchema.parse(parsed);
      if (validated.length > 0) layerVerdicts = validated as LayerVerdict[];
    } catch (err) {
      // Corrupt or legacy row — drop the field rather than crashing the
      // hydration. The triage stage will repopulate on the next scan.
      if (err instanceof z.ZodError) {
        diag.warn(
          "layer_verdicts_dropped",
          `dropping layerVerdicts for finding ${dbf.id}`,
          {
            finding_id: dbf.id,
            cause: "schema-mismatch",
            detail: formatZodError(err, "layerVerdicts"),
          },
        );
      } else if (err instanceof SyntaxError) {
        diag.warn(
          "layer_verdicts_dropped",
          `dropping layerVerdicts for finding ${dbf.id}`,
          { finding_id: dbf.id, cause: "invalid-json", detail: err.message },
        );
      }
    }
  }
  let pocSteps: PocStep[] | undefined;
  if (dbf.pocSteps) {
    try {
      const parsed = JSON.parse(dbf.pocSteps) as unknown;
      // Validate each element via the same predicate the agent tool path uses,
      // so a half-corrupt array degrades to "drop bad steps" rather than
      // letting malformed rows escape into Finding.pocSteps.
      const valid = parsePocStepsArg(parsed);
      if (valid && valid.length > 0) {
        pocSteps = valid;
      }
    } catch {
      // Corrupt or legacy row — drop the field rather than crashing
      // hydration. The agent loop is free to repopulate on a future scan.
    }
  }
  let semanticDedupe: Finding["semanticDedupe"];
  if (dbf.semanticDedupe) {
    try {
      const parsed: unknown = JSON.parse(dbf.semanticDedupe);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "canonicalId" in parsed &&
        typeof parsed.canonicalId === "string" &&
        "isCanonical" in parsed &&
        typeof parsed.isCanonical === "boolean" &&
        "clusterId" in parsed &&
        typeof parsed.clusterId === "string" &&
        "reason" in parsed &&
        typeof parsed.reason === "string"
      ) {
        semanticDedupe = {
          canonicalId: parsed.canonicalId,
          isCanonical: parsed.isCanonical,
          clusterId: parsed.clusterId,
          reason: parsed.reason,
        };
      }
    } catch {
      // Corrupt post-process metadata must not prevent a resume.
    }
  }
  let impactAssessment: Finding["impactAssessment"];
  if (dbf.impactAssessment) {
    // Reuse the module's own validated parser so a corrupt or legacy row
    // (e.g. an out-of-vocabulary reachability tier) degrades to "drop the
    // field" rather than leaking a malformed assessment into the Finding.
    impactAssessment = parseImpactAssessment(dbf.impactAssessment) ?? undefined;
  }
  const persistedFindingRank = dbf.findingRank;
  const findingRank =
    typeof persistedFindingRank === "number" &&
    Number.isSafeInteger(persistedFindingRank) &&
    persistedFindingRank > 0
      ? persistedFindingRank
      : undefined;
  return {
    id: dbf.id,
    templateId: dbf.templateId,
    title: dbf.title,
    description: dbf.description,
    severity: dbf.severity as Finding["severity"],
    category: dbf.category as Finding["category"],
    status: dbf.status as Finding["status"],
    confidence: dbf.confidence ?? undefined,
    cvssVector: dbf.cvssVector ?? undefined,
    cvssScore: dbf.cvssScore ?? undefined,
    evidence: {
      request: dbf.evidenceRequest,
      response: dbf.evidenceResponse,
      analysis: dbf.evidenceAnalysis ?? undefined,
    },
    ...(pocSteps ? { pocSteps } : {}),
    ...(layerVerdicts ? { layerVerdicts } : {}),
    ...(pocSteps ? { pocSteps } : {}),
    ...(impactAssessment ? { impactAssessment } : {}),
    ...(semanticDedupe ? { semanticDedupe } : {}),
    ...(findingRank !== undefined ? { findingRank } : {}),
    timestamp: dbf.timestamp,
  };
}
