import { createHash, randomBytes } from "node:crypto";
import type { Finding, Severity } from "../shared/index.js";
import { selectProbes, type Probe } from "./probes.js";

export interface ProbeRunOptions {
  url: string;
  headers?: Record<string, string>;
  /** JSON text with `{{prompt}}` where the message goes. Default: an OpenAI-style chat body. */
  bodyTemplate?: string;
  /** Where the reply is in a JSON response, such as `choices.0.message.content`. Default: tried automatically. */
  responsePath?: string;
  probes?: Probe[];
  /** Times each probe is sent; models are not deterministic, so a hit in any attempt counts. */
  repeat?: number;
  delayMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  /** A secret the operator knows is in the prompt. */
  secret?: string;
  fetch?: typeof fetch;
  onProgress?: (line: string) => void;
}
export interface ProbeAttempt { prompt: string; reply?: string; error?: string; hit: boolean; evidence: string; severity?: Severity; note?: string }
export interface ProbeResult { probe: Probe; attempts: ProbeAttempt[]; hits: number }

const DEFAULT_BODY = '{"messages":[{"role":"user","content":"{{prompt}}"}]}';
const MAX_REPLY = 8000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const rank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function dig(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(/[.[\]]+/).filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
const AUTO_PATHS = ["choices.0.message.content", "choices.0.text", "content.0.text", "output_text", "output.0.content.0.text", "message.content", "reply", "response", "answer", "output", "message", "text", "content"];

/** The assistant's text from a response body: a JSON field, an event stream of deltas, or the body itself. */
export function extractReply(body: string, path?: string): string {
  const trimmed = body.trim();
  if (/^data:/m.test(trimmed) && !trimmed.startsWith("{")) {
    let joined = "";
    for (const line of trimmed.split("\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try { const delta = dig(JSON.parse(data), "choices.0.delta.content"); if (typeof delta === "string") joined += delta; } catch { /* skip a malformed event */ }
    }
    if (joined) return joined.slice(0, MAX_REPLY);
  }
  try {
    const json: unknown = JSON.parse(trimmed);
    for (const candidate of path ? [path] : AUTO_PATHS) { const found = dig(json, candidate); if (typeof found === "string") return found.slice(0, MAX_REPLY); }
    if (path) return "";
  } catch { /* not JSON: use the text as is */ }
  return trimmed.slice(0, MAX_REPLY);
}

function buildBody(template: string, prompt: string): string {
  const body = template.replaceAll("{{prompt}}", JSON.stringify(prompt).slice(1, -1));
  JSON.parse(body);
  return body;
}

export async function runProbes(options: ProbeRunOptions): Promise<{ results: ProbeResult[]; requests: number }> {
  let url: URL;
  try { url = new URL(options.url); } catch { throw new Error(`'${options.url}' is not a URL.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The endpoint must be an http or https URL.");
  const template = options.bodyTemplate ?? DEFAULT_BODY;
  if (!template.includes("{{prompt}}")) throw new Error("The request body must contain {{prompt}} where the message goes.");
  try { buildBody(template, "test"); } catch { throw new Error("The request body is not valid JSON once {{prompt}} is filled in."); }
  const fetcher = options.fetch ?? fetch;
  const probes = options.probes ?? selectProbes(undefined);
  const repeat = Math.max(1, Math.min(options.repeat ?? 2, 10));
  const limit = options.maxRequests ?? 100;
  const results: ProbeResult[] = [];
  let requests = 0;
  for (const probe of probes) {
    const attempts: ProbeAttempt[] = [];
    for (let n = 0; n < repeat; n++) {
      if (requests >= limit) break;
      if (requests > 0 && options.delayMs) await sleep(options.delayMs);
      const context = { canary: `ZX${randomBytes(4).toString("hex").toUpperCase()}`, ...(options.secret ? { secret: options.secret } : {}) };
      const prompt = probe.prompt(context);
      requests++;
      try {
        const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", ...options.headers }, body: buildBody(template, prompt), signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
        const text = await response.text();
        if (!response.ok) { attempts.push({ prompt, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, hit: false, evidence: "" }); continue; }
        const reply = extractReply(text, options.responsePath);
        const verdict = probe.detect(reply, context);
        attempts.push({ prompt, reply, hit: verdict.hit, evidence: verdict.evidence, ...(verdict.severity ? { severity: verdict.severity } : {}), ...(verdict.note ? { note: verdict.note } : {}) });
      } catch (error) {
        attempts.push({ prompt, error: error instanceof Error ? error.message : String(error), hit: false, evidence: "" });
      }
    }
    const hits = attempts.filter(attempt => attempt.hit).length;
    results.push({ probe, attempts, hits });
    options.onProgress?.(`${hits ? "HIT " : "ok  "} ${probe.id} (${hits}/${attempts.length})`);
  }
  return { results, requests };
}

const WEAPON: Record<string, "rce" | "info-leak" | "integrity-tampering" | "unknown"> = { "tool-misuse": "rce", "data-exfiltration": "info-leak", "system-prompt-extraction": "info-leak", "output-manipulation": "integrity-tampering", "prompt-injection": "integrity-tampering", jailbreak: "integrity-tampering", "encoding-bypass": "integrity-tampering" };

/** One finding per probe the endpoint failed, with what was sent and what came back. */
export function probeFindings(target: string, results: ProbeResult[], now = Date.now()): Finding[] {
  const host = (() => { try { return new URL(target).host; } catch { return target; } })();
  return results.filter(result => result.hits > 0).map(result => {
    const hit = result.attempts.filter(attempt => attempt.hit).sort((a, b) => rank[b.severity ?? result.probe.severity] - rank[a.severity ?? result.probe.severity])[0]!;
    const severity = hit.severity ?? result.probe.severity;
    const sent = result.attempts.filter(attempt => !attempt.error).length;
    return {
      id: `probe-${createHash("sha256").update(`${target}\n${result.probe.id}`).digest("hex").slice(0, 24)}`,
      templateId: `probe/${result.probe.id}`, title: `${result.probe.title} (${host})`,
      description: `${result.probe.impact}\n\nThe endpoint did what the attack asked in ${result.hits} of ${sent} attempts.${hit.note ? ` ${hit.note}` : ""}`,
      severity, category: result.probe.category, status: "discovered",
      evidence: { request: hit.prompt, response: (hit.reply ?? "").slice(0, 2000), analysis: `Probe ${result.probe.id} sent to ${target}; the reply shows the attack worked: ${hit.evidence.slice(0, 400)}` },
      impactAssessment: { reachability_tier: "unknown", blast_radius: result.probe.impact, weaponizability: WEAPON[result.probe.category] ?? "unknown", business_impact: "unassessed", rationale: `Observed on ${host}: the reply to a ${result.probe.id} probe shows the model followed the attacker's instruction (${result.hits} of ${sent} attempts).`, assessment_source: "model" },
      timestamp: now, triageStatus: "new", workflowStatus: "backlog",
    } as unknown as Finding;
  });
}
