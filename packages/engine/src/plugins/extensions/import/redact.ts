/**
 * Secrets in imported MCP definitions. A legacy server may carry a key in its url (`?api_key=...`, `user:pass@`) or in
 * its args (`--token abc`, `--api-key=abc`, a bare `sk-...`). They are replaced by `${NAME}` placeholders BEFORE the
 * definition reaches `.mcp.json`, the approved capabilities or the audit log; each placeholder name is returned so it
 * can be declared as an environment variable (name only, never the value). Pure.
 */
const SECRET_NAME = /(^|[-_.])(api[-_]?key|apikey|key|token|secret|password|passwd|pwd|auth|authorization|bearer|signature|sig|session|credential|access[-_]?token|client[-_]?secret)([-_.]|$)/i;
const SECRET_VALUE = /^(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}.*|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/;

export const placeholderName = (raw: string): string => (raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(?=\d)/, "X_") || "SECRET");
const isPlaceholder = (v: string): boolean => /^\$\{[A-Z][A-Z0-9_]*\}$/.test(v);
const withKind = (name: string): string => (/^(TOKEN|KEY|SECRET|PASSWORD|PASS)$/.test(name) ? `MCP_${name}` : /_(TOKEN|KEY|SECRET|PASSWORD|PASS|ID)$/.test(name) ? name : `${name}_TOKEN`);

export interface Redacted<T> { value: T; names: string[] }

export function redactUrl(url: string): Redacted<string> {
  const names: string[] = [];
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { value: SECRET_VALUE.test(url) ? "${URL_TOKEN}" : url, names: SECRET_VALUE.test(url) ? ["URL_TOKEN"] : [] }; }
  if (parsed.username || parsed.password) {
    if (parsed.password) { parsed.password = "PLACEHOLDER_PASSWORD"; names.push("URL_PASSWORD"); }
    if (parsed.username && SECRET_VALUE.test(parsed.username)) { parsed.username = "PLACEHOLDER_USER"; names.push("URL_USER"); }
  }
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    if (value && !isPlaceholder(value) && (SECRET_NAME.test(key) || SECRET_VALUE.test(value))) { const name = withKind(placeholderName(key)); parsed.searchParams.set(key, `PLACEHOLDER_${name}`); names.push(name); }
  }
  if (SECRET_VALUE.test(parsed.hash.slice(1))) { parsed.hash = "PLACEHOLDER_URL_TOKEN"; names.push("URL_TOKEN"); }
  // URL percent-encodes `${}`; restore the placeholders so the stored text reads `${NAME}`.
  const text = parsed.toString().replace(/PLACEHOLDER_PASSWORD/g, "${URL_PASSWORD}").replace(/PLACEHOLDER_USER/g, "${URL_USER}").replace(/PLACEHOLDER_URL_TOKEN/g, "${URL_TOKEN}").replace(/PLACEHOLDER_([A-Z0-9_]+)/g, "${$1}");
  return { value: text, names: [...new Set(names)] };
}

export function redactArgs(args: readonly string[]): Redacted<string[]> {
  const names: string[] = []; const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = /^(--?[A-Za-z0-9][A-Za-z0-9_-]*)=(.*)$/s.exec(arg);
    if (eq && eq[2] && !isPlaceholder(eq[2]) && (SECRET_NAME.test(eq[1]!) || SECRET_VALUE.test(eq[2]))) { const name = withKind(placeholderName(eq[1]!.replace(/^-+/, ""))); names.push(name); out.push(`${eq[1]}=\${${name}}`); continue; }
    if (/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(arg) && SECRET_NAME.test(arg) && args[i + 1] !== undefined && !args[i + 1]!.startsWith("-") && !isPlaceholder(args[i + 1]!)) {
      const name = withKind(placeholderName(arg.replace(/^-+/, ""))); names.push(name); out.push(arg, `\${${name}}`); i++; continue;
    }
    if (/^https?:\/\//i.test(arg)) { const r = redactUrl(arg); names.push(...r.names); out.push(r.value); continue; }
    if (!isPlaceholder(arg) && SECRET_VALUE.test(arg)) { names.push("ARG_TOKEN"); out.push("${ARG_TOKEN}"); continue; }
    out.push(arg);
  }
  return { value: out, names: [...new Set(names)] };
}
