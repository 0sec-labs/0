import type { ScanConfig, Finding, LayerVerdict, LayerVerdictKind, Severity, TriageLayerName } from "../shared/index.js";
import type { ApiRuntimeDiagnostics } from "../runtime/llm-api.js";
import { z } from "zod";
import { getOrCreateRateLimiter } from "../agentic/scan-config.js";
import { isExplicitLocalTargetPath, resolveLocalTargetPath } from "../path-resolution.js";

/**
 * Append a triage-layer verdict to a finding's `layerVerdicts` log. The
 * array is created lazily so existing call sites that don't construct
 * findings via the scanner (tests, importers) keep working.
 *
 * Each entry is the per-layer telemetry that #112 was designed to surface
 * and that the dynamic-routing model in #113 trains on. Append-only,
 * ordered by execution.
 */
export function pushLayerVerdict(
  finding: Finding,
  entry: {
    layer: TriageLayerName;
    verdict: LayerVerdictKind;
    confidence?: number;
    reason: string;
    startedAt: number;
    costUsd?: number;
    changedSeverity?: { from: Severity; to: Severity };
  },
): void {
  if (!finding.layerVerdicts) finding.layerVerdicts = [];
  const verdict: LayerVerdict = {
    layer: entry.layer,
    verdict: entry.verdict,
    reason: entry.reason,
    durationMs: Date.now() - entry.startedAt,
    costUsd: entry.costUsd ?? 0,
  };
  if (entry.confidence !== undefined) verdict.confidence = entry.confidence;
  if (entry.changedSeverity) verdict.changedSeverity = entry.changedSeverity;
  finding.layerVerdicts.push(verdict);
}

export function assertApiRuntimeSelection(
  requestedRuntime: ScanConfig["runtime"] | undefined,
  diagnostics: ApiRuntimeDiagnostics,
): void {
  if (requestedRuntime === "api" && !diagnostics.valid) {
    throw new Error(diagnostics.fatalError ?? `${diagnostics.providerLabel} runtime is not available.`);
  }

  if ((requestedRuntime === "auto" || requestedRuntime === undefined) && diagnostics.reason === "invalid_config") {
    throw new Error(diagnostics.fatalError ?? `${diagnostics.providerLabel} runtime is misconfigured.`);
  }
}

export function hasDirectChatGptCodexProvider(
  diagnostics: ApiRuntimeDiagnostics,
): boolean {
  return diagnostics.valid && diagnostics.provider === "chatgpt-codex";
}

/** Normalize target spelling without making requests before scope admission. */
export function normalizeScanConfig(config: ScanConfig): ScanConfig {
  if (config.repoPath) {
    config = { ...config, repoPath: resolveLocalTargetPath(config.repoPath) };
  }

  // Normalize target URL first — if the user gave a bare hostname like
  // `example.com`, every URL-using tool downstream (`crawl`, `http_request`,
  // playwright `goto`) blows up with "Invalid URL" on `new URL(input,
  // ctx.target)` because the base must be absolute. Auto-prefix `https://`
  // when no scheme is present so the rest of the pipeline gets a
  // well-formed URL. Skips package targets (npm/pypi/cargo names like
  // "lodash") — those don't have `.` or `://` in a way that triggers
  // this branch, and audit-mode targets aren't URLs anyway.
  if (
    config.target &&
    !isExplicitLocalTargetPath(config.target) &&
    /\./.test(config.target) &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(config.target)
  ) {
    config = { ...config, target: `https://${config.target.trim()}` };
  }
  return config;
}

/** Classify an admitted target. Redirects require separate scope admission. */
export async function detectScanMode(config: ScanConfig): Promise<ScanConfig> {
  // Only auto-route for default/deep mode on HTTP targets
  const requestedMode = config.mode ?? "deep";
  if (requestedMode !== "deep") return config;
  if (!config.target.startsWith("http://") && !config.target.startsWith("https://")) return config;

  try {
    // #214: rate-limit even the one-shot mode-auto-detect probe. The
    // limiter is built (and cached on `config`) here so subsequent
    // stages share the same per-host bucket state — a target that 429s
    // on the first probe stays parked across the whole scan.
    const limiter = getOrCreateRateLimiter(config);
    await limiter.acquire(config.target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.timeout ?? 30_000, 8_000));
    try {
      // Scope admission precedes this probe; redirects are never followed.
      // foxguard: ignore[js/no-ssrf]
      const response = await fetch(config.target, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        },
        signal: config.signal ? AbortSignal.any([controller.signal, config.signal]) : controller.signal,
      });
      limiter.noteResponse(config.target, response);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return config;
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      const body = await response.text();

      // Check if response is HTML (web app)
      const looksHtml =
        contentType.includes("text/html")
        || /^\s*<!doctype html/i.test(body)
        || /<html[\s>]/i.test(body);

      if (looksHtml) {
        return { ...config, mode: "web" };
      }

      // Check if response looks like an AI/LLM API endpoint
      // Common patterns: /v1/chat/completions, /v1/messages, /completions, /generate
      const url = new URL(config.target);
      const aiPathPatterns = [
        /\/v\d+\/chat/,
        /\/v\d+\/messages/,
        /\/completions/,
        /\/generate/,
        /\/inference/,
      ];
      const looksLikeAiEndpoint = aiPathPatterns.some((p) => p.test(url.pathname));

      // If it's a JSON API that doesn't match AI patterns, still use deep mode
      // but if it returned 405 on GET, it's likely a POST-only API
      if (response.status === 405 && !looksLikeAiEndpoint) {
        // POST-only endpoint that's not an AI API — likely a web API, keep deep mode
        return config;
      }

      // If JSON response with common AI indicators, keep deep mode (AI scanning)
      if (contentType.includes("application/json")) {
        try {
          const json = JSON.parse(body);
          const hasAiIndicators =
            json.model || json.choices || json.content || json.completion
            || json.object === "chat.completion" || json.object === "message";
          if (hasAiIndicators) return config; // Confirmed AI endpoint
        } catch {
          // Not valid JSON, proceed with default
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Keep the requested mode if preflight fails
  }

  return config;
}
