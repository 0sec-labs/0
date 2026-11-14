// Scope-aware validation of command tokens and target URLs.
// Extracted verbatim from ../tools.ts; the public API is re-exported there.
import { isAbsolute, resolve } from "node:path";
import type { ToolContext } from "../types.js";
import type { ScopePolicy } from "../../scope/scope.js";
import { normalizeScopeHostname } from "../../scope/scope.js";
import type { EnforcementTracker } from "../../scope/enforcement.js";
import { isScopeEnforcementEnabled } from "../../scope/activation.js";
import { isPrivateAddress, isAllowedLocalOrigin } from "../../http.js";
import { resolveScopedPath } from "./scope-path.js";

export function validateScopedCommand(tokens: string[], scopePath?: string): string[] {
  if (!isScopeEnforcementEnabled()) return tokens;
  return tokens.map((token, index) => {
    if (index === 0) return token;
    if (isAbsolute(token)) {
      // Canonicalize the operand used at the process sink. Lexical resolve() is
      // insufficient: package tarballs may carry symlinks to credentials outside
      // the audit directory, and validating then executing the original spelling
      if (scopePath) {
        try {
          return resolveScopedPath(scopePath, token);
        } catch {
          // Fall through to the public refusal below; do not expose the
          // resolved host path to an untrusted audit agent.
        }
      }
      throw new Error(`Absolute paths are not allowed in scoped commands: ${token}`);
    }
    if (/(^|\/)\.\.(\/|$)/.test(token)) {
      throw new Error(`Parent-path traversal is not allowed in scoped commands: ${token}`);
    }
    return token;
  });
}



export function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeScopeHostname(hostname);
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

export function validateTargetUrl(
  baseUrl: string,
  requestedUrl: string,
  scope?: ScopePolicy,
  enforcement?: EnforcementTracker,
  publicNetwork?: ToolContext["publicNetwork"],
): string {
  let base: URL | undefined;
  if (publicNetwork || !isScopeEnforcementEnabled()) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") base = parsed;
    } catch { /* A task path is not a network or private-access grant. */ }
  } else {
    base = new URL(baseUrl);
  }
  const candidate = new URL(requestedUrl, base);

  if (!["http:", "https:"].includes(candidate.protocol)) {
    throw new Error(`Unsupported protocol for http_request: ${candidate.protocol}`);
  }

  const hostname = normalizeScopeHostname(candidate.hostname);
  const baseHostname = base ? normalizeScopeHostname(base.hostname) : "";
  const baseIsLocal = !!base && (isLocalHostname(baseHostname) || isPrivateAddress(baseHostname));
  const candidateIsLocal = isLocalHostname(hostname) || isPrivateAddress(hostname);

  // Absolute private/internal-network guard (SSRF rail). This is the ONE
  // check scope can never lift: an approved scope must not become a path
  // to SSRF against localhost / RFC1918 / link-local metadata endpoints
  // (169.254.169.254, 127.0.0.1, …) when the base is a public target.
  // It runs before scope authorization so an in-scope local host is
  // still refused.
  if (candidateIsLocal && !baseIsLocal && !isAllowedLocalOrigin(candidate)) {
    throw new Error(`Local/internal http_request blocked: ${candidate.hostname}`);
  }

  const candidateUrl = candidate.toString();
  if (isScopeEnforcementEnabled() && publicNetwork?.deniedHosts?.has(hostname)) {
    throw new Error(`Operator-denied HTTP host: ${hostname}`);
  }
  const effectiveScope = publicNetwork ? publicNetwork.scope : scope;

  // Cross-origin / scope authorization (0#215, cross-origin-in-scope fix).
  //
  // The same-origin rail is the correct default for a *scopeless* console:
  // with no operator-approved scope, never wander off the single named
  // target's origin. But once an operator has approved a `scope` that
  // COVERS the candidate host, the scope is the authority — an in-scope
  // host is permitted even when its origin differs from the base target's
  // (e.g. an approved sibling subdomain like api.doruk.ch).
  //
  // Order:
  //   1. If a scope is present, it decides. In-scope → authorized (origin
  //      may differ). Out-of-scope → hard block (noteOutOfScopeBlocked).
  //   2. If no scope is present, fall back to the same-origin rail —
  //      BYTE-IDENTICAL to the pre-fix behaviour so scopeless callers and
  //      their tests are unchanged.
  // The private-network guard above already ran, so scope can never
  // authorize an SSRF target.
  if (effectiveScope) {
    const verdict = effectiveScope.enforce(candidateUrl)
    if (!verdict.allowed) {
      enforcement?.noteOutOfScopeBlocked();
      throw new Error(`Scope violation blocked: ${verdict.reason}`);
    }
    // In scope → the scope check is the authority; the same-origin rail
    // does not override an explicitly-approved in-scope host.
  } else if (isScopeEnforcementEnabled() && !publicNetwork && candidate.origin !== base!.origin && !isAllowedLocalOrigin(candidate)) {
    // Scopeless default: same-origin only. Identical error/message/caller
    // contract as before the fix.
    throw new Error(`Cross-origin http_request blocked: ${candidate.origin}`);
  }

  // http_audit path-prefix allowlist (FROZEN CONTRACT). Layered on top of
  // the host scope above: a URL must pass BOTH the host check and the path
  // check. Empty path allowlist = allow all paths. Out-of-scope path is
  // counted as a blocked request, same as a host violation.
  if (isScopeEnforcementEnabled() && enforcement) {
    const pathVerdict = enforcement.pathPolicy.enforce(candidateUrl);
    if (!pathVerdict.allowed) {
      enforcement.noteOutOfScopeBlocked();
      throw new Error(`Scope violation blocked: ${pathVerdict.reason}`);
    }
    enforcement.noteInScope();
  }

  return candidateUrl;
}
