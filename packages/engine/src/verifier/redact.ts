/**
 * Redaction for the log tail stored with a verifier result. Self-contained on
 * purpose: the verifier is a leaf module and must not depend on the rest of
 * the engine. Conservative: it errs toward hiding.
 */
const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED TOKEN]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]"],
  [/(:\/\/[^\s:@/]+:)[^\s@/]+@/g, "$1[REDACTED]@"],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*["']?[^\s"']{6,}/gi, "$1=[REDACTED]"],
];

export function redactLog(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
