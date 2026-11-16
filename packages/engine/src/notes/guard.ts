// What may never become a note: secrets and hidden characters. Pure text rules, no I/O.
// A note is plain context shown to the model in every thread, so a key saved once would be
// replayed everywhere, and invisible characters could carry instructions a reviewer cannot see.

/** Zero-width, bidi, soft hyphen, word joiner, variation-selector and Unicode tag characters. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDFFF]|\uD834[\uDD73-\uDD7A]/g;
/** Characters that redirect or hide text: a note containing them is refused instead of cleaned. */
const SPOOFING = /[\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function stripHidden(input: string): string {
  return input.replace(INVISIBLE, "").replace(CONTROL, "");
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:password|passwd|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|authorization)\b["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i,
];

function entropy(token: string): number {
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / token.length; bits -= p * Math.log2(p); }
  return bits;
}

function highEntropyToken(text: string): boolean {
  for (const token of text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && entropy(token) >= 4) return true;
    if (/^[A-Fa-f0-9]{64,}$/.test(token) && entropy(token) >= 3) return true;
  }
  return false;
}

export function looksLikeSecret(text: string): boolean {
  const flat = text.normalize("NFKC");
  return SECRET_PATTERNS.some(pattern => pattern.test(flat)) || highEntropyToken(flat);
}

export type Screen = { ok: true; text: string } | { ok: false; reason: "secret" | "hidden"; message: string };
export const NOT_SAVED_SECRET = "Not saved: looks like a secret (key, token, password or private key). Notes are shown to the model in every thread; do not store credentials.";
export const NOT_SAVED_HIDDEN = "Not saved: contains hidden or direction-changing characters.";

/** Refuses a note that hides characters or looks like a credential. Returns the text with zero-width and control characters removed. */
export function screenText(input: string): Screen {
  if (SPOOFING.test(input)) return { ok: false, reason: "hidden", message: NOT_SAVED_HIDDEN };
  const text = stripHidden(input);
  if (looksLikeSecret(text)) return { ok: false, reason: "secret", message: NOT_SAVED_SECRET };
  return { ok: true, text };
}
