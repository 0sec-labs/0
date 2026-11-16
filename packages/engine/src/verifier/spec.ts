/**
 * Verifier spec (pure). Declared as `verify:` in a skill's frontmatter and
 * parsed here; nothing in this file touches the filesystem or a process.
 *
 * The command comes from the skill, never from the repository, the finding or
 * the model. See docs/design/fix-verification.md.
 */

export type VerifyNetwork = "none" | "allowed";

export interface VerifyStep {
  name: string;
  run: string;
  /** Digest-pinned image for this step; defaults to the spec image. */
  image?: string;
}

export interface VerifySuccess {
  /** Every step must exit 0. Defaults to true unless a baseline comparison is declared. */
  exit0: boolean;
  /** Combined step output must match this regular expression. */
  regex?: string;
  /** "no worse than before": the failure metric after must not exceed the metric before. */
  baseline?: "no-worse";
  /** Regex whose first capture group is an integer count; absent means exit code != 0 counts as 1. */
  metric?: string;
}

export interface VerifyCanary {
  /** Step that must flag the marker. */
  step: string;
  /** Path (relative, inside the snapshot) where the marker is planted in a temp copy. */
  file: string;
  content: string;
  /** Regex over the step output; when absent a non-zero exit counts as flagged. */
  expect?: string;
}

export interface VerifySpec {
  steps: VerifyStep[];
  image?: string;
  /** Runs first, with network, before the network is cut. */
  setup?: string;
  network: VerifyNetwork;
  timeoutSec: number;
  success: VerifySuccess;
  canary?: VerifyCanary;
}

export type ParseVerifyResult = { ok: true; spec: VerifySpec } | { ok: false; error: string };

const DIGEST_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const STEP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_TIMEOUT_SEC = 1800;
const MAX_COMMAND = 4096;

export function isPinnedImage(image: string): boolean {
  return DIGEST_IMAGE.test(image);
}

export function imageDigest(image: string): string | undefined {
  const at = image.indexOf("@");
  return at >= 0 ? image.slice(at + 1) : undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (error: string): ParseVerifyResult => ({ ok: false, error: `verify: ${error}` });

function validRegex(pattern: unknown, label: string): string | undefined {
  if (typeof pattern !== "string" || !pattern || pattern.length > 512) return `${label} must be a regular expression string`;
  try { new RegExp(pattern); } catch { return `${label} is not a valid regular expression`; }
  return undefined;
}

function parseTimeout(value: unknown): number | undefined {
  if (value === undefined) return 120;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+s?$/.test(value) ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_TIMEOUT_SEC ? n : undefined;
}

/** Parse an untrusted `verify` value. Never throws. */
export function parseVerifySpec(raw: unknown): ParseVerifyResult {
  if (!isRecord(raw)) return fail("must be a mapping");
  const known = new Set(["steps", "command", "image", "setup", "network", "timeout", "success", "canary"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) return fail(`unknown key "${key}"`);

  let image: string | undefined;
  if (raw.image !== undefined) {
    if (typeof raw.image !== "string" || !isPinnedImage(raw.image)) return fail("image must be pinned by digest (name@sha256:<64 hex>); tags are not accepted");
    image = raw.image;
  }

  const rawSteps: unknown[] = raw.steps !== undefined ? (Array.isArray(raw.steps) ? raw.steps : []) : typeof raw.command === "string" ? [{ name: "verify", run: raw.command }] : [];
  if (rawSteps.length === 0 || rawSteps.length > 8) return fail("declare `command` or 1 to 8 `steps`");
  const steps: VerifyStep[] = [];
  for (const item of rawSteps) {
    if (!isRecord(item) || typeof item.name !== "string" || !STEP_NAME.test(item.name)) return fail("each step needs a name of lowercase letters, digits, - or _");
    if (typeof item.run !== "string" || !item.run.trim() || item.run.length > MAX_COMMAND) return fail(`step "${item.name}" needs a command`);
    if (steps.some((s) => s.name === item.name)) return fail(`duplicate step name "${item.name}"`);
    let stepImage: string | undefined;
    if (item.image !== undefined) {
      if (typeof item.image !== "string" || !isPinnedImage(item.image)) return fail(`step "${item.name}" image must be pinned by digest`);
      stepImage = item.image;
    }
    if (!stepImage && !image) return fail(`step "${item.name}" has no image; declare a digest-pinned image`);
    steps.push({ name: item.name, run: item.run.trim(), ...(stepImage ? { image: stepImage } : {}) });
  }

  if (raw.setup !== undefined && (typeof raw.setup !== "string" || !raw.setup.trim() || raw.setup.length > MAX_COMMAND)) return fail("setup must be a command string");
  const network = raw.network === undefined ? "none" : raw.network;
  if (network !== "none" && network !== "allowed") return fail('network must be "none" or "allowed"');
  const timeoutSec = parseTimeout(raw.timeout);
  if (timeoutSec === undefined) return fail(`timeout must be 1 to ${MAX_TIMEOUT_SEC} seconds`);

  const successRaw = raw.success === undefined || raw.success === "exit0" ? {} : raw.success;
  if (!isRecord(successRaw)) return fail("success must be a mapping");
  for (const key of Object.keys(successRaw)) if (!["exit0", "regex", "baseline", "metric"].includes(key)) return fail(`unknown success key "${key}"`);
  if (successRaw.baseline !== undefined && successRaw.baseline !== "no-worse") return fail('success.baseline must be "no-worse"');
  if (successRaw.exit0 !== undefined && typeof successRaw.exit0 !== "boolean") return fail("success.exit0 must be true or false");
  for (const key of ["regex", "metric"] as const) {
    if (successRaw[key] !== undefined) { const err = validRegex(successRaw[key], `success.${key}`); if (err) return fail(err); }
  }
  if (successRaw.metric !== undefined && successRaw.baseline === undefined) return fail("success.metric needs success.baseline");
  const baseline = successRaw.baseline === "no-worse" ? ("no-worse" as const) : undefined;
  const success: VerifySuccess = {
    exit0: typeof successRaw.exit0 === "boolean" ? successRaw.exit0 : baseline === undefined,
    ...(typeof successRaw.regex === "string" ? { regex: successRaw.regex } : {}),
    ...(baseline ? { baseline } : {}),
    ...(typeof successRaw.metric === "string" ? { metric: successRaw.metric } : {}),
  };

  let canary: VerifyCanary | undefined;
  if (raw.canary !== undefined) {
    const c = raw.canary;
    if (!isRecord(c) || typeof c.step !== "string" || !steps.some((s) => s.name === c.step)) return fail("canary.step must name a step");
    if (typeof c.file !== "string" || !c.file || c.file.startsWith("/") || c.file.split("/").some((p) => p === ".." || p === "")) return fail("canary.file must be a relative path inside the snapshot");
    if (typeof c.content !== "string" || !c.content || c.content.length > 8192) return fail("canary.content must be the marker text to plant");
    if (c.expect !== undefined) { const err = validRegex(c.expect, "canary.expect"); if (err) return fail(err); }
    canary = { step: c.step, file: c.file, content: c.content, ...(typeof c.expect === "string" ? { expect: c.expect } : {}) };
  }

  return { ok: true, spec: { steps, ...(image ? { image } : {}), ...(typeof raw.setup === "string" ? { setup: raw.setup.trim() } : {}), network, timeoutSec, success, ...(canary ? { canary } : {}) } };
}

/** Inline verify for `scan fix --test-command`: one step, exit 0. The image is optional (absent means the host adapter). */
export function inlineVerifySpec(command: string, timeoutSec: number, image?: string): VerifySpec {
  return {
    steps: [{ name: "test", run: command.trim(), ...(image ? { image } : {}) }],
    ...(image ? { image } : {}),
    network: "none", timeoutSec, success: { exit0: true },
  };
}
