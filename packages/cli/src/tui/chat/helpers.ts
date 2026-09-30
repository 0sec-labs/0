import {
  ScopePolicy,
  type ConsoleAutonomyMode,
  type ConsoleScopeRequest,
  type ConsoleScopeResolution,
} from "@0/core";
import type { Theme } from "../theme-context.js";
import type { HerdDetailTone } from "../herd-layout.js";
import type { SlashCommand } from "@0/shared"
import { fitTuiText, sanitizeTuiText } from "../text.js";

const ACTIVITY_WIDTH = 88;
const SENSITIVE_MARKER = /authorization|bearer|basic|api[\s_-]*key|access[\s_-]*key|secret|password|passwd|pwd|token|cookie|credential|passphrase/i;
const PRIVATE_VALUE = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[bap]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/;

/** A bounded display-only excerpt. Tool arguments and model prose are untrusted. */
export function activityExcerpt(value: unknown, width = ACTIVITY_WIDTH): string {
  const text = sanitizeTuiText(value)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "");
  // Unstructured commands and model prose have no reliable argument schema.
  // Withhold the *whole* excerpt when it mentions credentials rather than
  // guessing where an unquoted or partially streamed secret value ends.
  if (SENSITIVE_MARKER.test(text) || PRIVATE_VALUE.test(text)) return fitTuiText("sensitive details omitted", width);
  return fitTuiText(text
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[redacted]"), width);
}

/**
 * Promote complete sentences/lines from streamed reasoning, or the first
 * seven words of a still-open fragment once they are stable. Nothing here
 * predicts the model's next step. Settled entries can use the final fragment.
 */
export function reasoningExcerpt(text: string, settled = false): string {
  const recent = text.slice(-1600);
  let start = 0;
  let complete = "";
  for (const boundary of recent.matchAll(/[.!?](?=\s|$)|\n/g)) {
    const end = boundary.index + boundary[0].length;
    const candidate = recent.slice(start, end).trim();
    if (candidate.length >= 12) complete = candidate;
    start = end;
  }
  const fragment = recent.slice(start).trim();
  const words = fragment.split(/\s+/);
  const stableFragment = words.length >= 8 ? words.slice(0, 7).join(" ") : "";
  const candidate = settled && fragment.length >= 12 ? fragment : stableFragment || complete;
  return activityExcerpt(candidate.replace(/^[#>*\s-]+/, ""), 68);
}

export function toolActivity(name: string, args?: string): string {
  const title = activityExcerpt(name, 40) || "tool";
  const detail = activityExcerpt(args, 64);
  return fitTuiText(detail ? `${title} · ${detail}` : title, ACTIVITY_WIDTH);
}

export function modeLabel(mode: ConsoleAutonomyMode): string {
  if (mode === "standard") return "Standard";
  if (mode === "recon") return "Recon";
  return mode === "copilot" ? "Co-pilot" : "YOLO";
}

/**
 * Colour for an autonomy mode, shared by the header indicator and any other
 * place the mode is shown: Standard=white (neutral), Recon=blue (passive),
 * Co-pilot=purple (the brand accent), YOLO=red (no prompts).
 */
export function modeColorFor(mode: ConsoleAutonomyMode, theme: Theme): string {
  if (mode === "recon") return theme.INFO;
  if (mode === "copilot") return theme.BRAND;
  if (mode === "yolo") return theme.ERROR;
  return theme.TEXT;
}

/**
 * Map a herd focus line's tone onto the theme — the same mapping `herd-screen`
 * uses for its focus panes, mirrored here so the INLINE focus view drilled into
 * from the chat renders identically. Red (ERROR) is never produced from a tone;
 * WARNING carries a failed status, so the "red = errors" invariant holds.
 */
export function herdToneColor(theme: Theme, tone: HerdDetailTone): string {
  switch (tone) {
    case "title":
      return theme.PRIMARY;
    case "accent":
      return theme.ACCENT;
    case "warn":
      return theme.WARNING;
    case "muted":
    case "blank":
      return theme.MUTED;
    default:
      return theme.TEXT;
  }
}

export function completionFor(command: SlashCommand, args = ""): string {
  const base = `/${command.name}`;
  if (args) return `${base} ${args}`;
  return command.usage?.includes(" ") ? `${base} ` : base;
}

export function commandMatchesPrefix(command: SlashCommand, rawName: string): boolean {
  return rawName.length === 0
    || command.name.startsWith(rawName)
    || command.aliases.some((alias) => alias.startsWith(rawName));
}

export function buildScopeResolution(request: ConsoleScopeRequest): ConsoleScopeResolution | null {
  const raw = request.currentScope?.raw ?? {};
  const inScope = new Set(raw.in_scope ?? []);
  let target = request.target.trim();

  for (const requestedUrl of request.requestedUrls) {
    try {
      const url = new URL(requestedUrl);
      inScope.add(url.hostname);
      if (!target) target = url.origin;
    } catch {
      return null;
    }
  }

  if (!target || inScope.size === 0) return null;
  const scope = ScopePolicy.fromJson({ ...raw, in_scope: [...inScope] });
  if (request.requestedUrls.some((url) => !scope.match(url).allowed)) return null;
  return { target, scope };
}
