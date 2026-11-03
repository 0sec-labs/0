/**
 * Objective generation for `0 campaign` — one direct HTTPS call to the
 * OpenRouter chat completions API. Pure parsing helpers are exported for
 * the test suite; no network call happens unless `generateObjective` is
 * invoked by the running command (tests inject `fetchImpl`).
 *
 * API keys are never logged: error messages quote neither the key nor
 * the response body verbatim.
 */

export interface CampaignObjective {
  objective: string;
  tests: string[];
  stop: boolean;
  reason: string;
}

export interface FindingSummary {
  title: string;
  severity: string;
}

/** Defensive fallback when objective generation fails twice. */
export const GENERIC_OBJECTIVE: CampaignObjective = {
  objective:
    "Continue systematic probing of the target to broaden coverage: map attack surface not yet exercised and probe the most promising uncovered gaps.",
  tests: [],
  stop: false,
  reason: "objective generation failed; using generic fallback objective",
};

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Parse a model response into a strict campaign objective.
 * Returns null when the payload cannot be trusted (code-fenced JSON is
 * accepted; garbage, missing fields or wrong shapes are not).
 */
export function parseObjectiveResponse(raw: string): CampaignObjective | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) text = (fence[1] ?? "").trim();
  if (!text || !text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.objective !== "string" || !record.objective.trim()) return null;
  const tests = record.tests === undefined
    ? []
    : Array.isArray(record.tests)
      ? record.tests.filter((entry): entry is string => typeof entry === "string")
      : null;
  if (tests === null) return null;
  return {
    objective: record.objective.trim(),
    tests,
    stop: record.stop === true,
    reason: typeof record.reason === "string" ? record.reason : "",
  };
}

/**
 * Build the objective-generation prompt: target, scope hosts, finding
 * titles+severities so far, a compact digest of previous iterations, and
 * strict-JSON output instructions.
 */
export function buildObjectivePrompt(input: {
  target: string;
  scopeHosts: readonly string[];
  findings: readonly FindingSummary[];
  priorSummaries: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(
    `You are the campaign director of an authorized, self-directed security research campaign against ${input.target}.`,
  );
  lines.push(`Authorized scope hosts: ${input.scopeHosts.length ? input.scopeHosts.join(", ") : "(see scope policy)"}.`);
  lines.push("");
  lines.push("Findings recorded so far (title — severity):");
  if (input.findings.length === 0) {
    lines.push("(none)");
  } else {
    for (const finding of input.findings) lines.push(`- ${finding.title} — ${finding.severity}`);
  }
  lines.push("");
  if (input.priorSummaries.length > 0) {
    lines.push("What previous campaign iterations probed:");
    input.priorSummaries.forEach((summary, index) => lines.push(`- iteration ${index + 1}: ${summary}`));
    lines.push("");
  }
  lines.push(
    "Formulate the NEXT objective: what to probe deeper, or what was missed. Avoid repeating what findings or previous iterations already cover.",
  );
  lines.push(
    "Standing duty: if any recorded high or critical finding lacks hands-on proof of its claimed impact, the next objective should be to reproduce it end-to-end and capture the evidence (drive the actual terminal, API, or browser surface) before hunting anything new.",
  );
  lines.push(
    'Reply with STRICT JSON only (no prose, no markdown): {"objective": string, "tests": [string], "stop": boolean, "reason": string}.',
  );
  lines.push(
    '"tests" is a short list of concrete tests for the next iteration. Set "stop": true when coverage is sufficient and further probing adds nothing.',
  );
  return lines.join("\n");
}

export interface GenerateObjectiveOptions {
  model: string;
  apiKey: string;
  prompt: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
}

/**
 * Call the chat completions endpoint and parse the objective. Parse
 * failures are retried once, then the generic fallback (stop=false) is
 * returned so the campaign never stalls on a malformed model answer.
 */
export async function generateObjective(options: GenerateObjectiveOptions): Promise<CampaignObjective> {
  const model = options.model.replace(/^openrouter\//, "");
  const endpoint = options.endpoint ?? ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  let lastRaw = "";
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: options.prompt }],
        }),
      });
      if (!response.ok) throw new Error(`objective endpoint returned HTTP ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
      lastRaw = typeof content === "string" ? content : "";
      const parsed = parseObjectiveResponse(lastRaw);
      if (parsed) return parsed;
    } catch {
      // fall through to the next attempt; the key and body are never logged
    }
  }
  return { ...GENERIC_OBJECTIVE };
}
