/**
 * Self-edit protected-path policy.
 *
 * This module is itself on the protected list: a diff that touches it fails
 * the gate. It is evaluated by the live dashboard process against
 * `git diff --name-only` of the self/* worktree, never by the agent, and the
 * check fails CLOSED: an unreadable diff or an unparseable path blocks the gate.
 */

export interface ProtectedRule { id: string; reason: string; test: RegExp }

const ext = "(?:ts|tsx|mts|cts|js|mjs|cjs|json|yaml|yml|sh)";
export const PROTECTED_RULES: readonly ProtectedRule[] = [
  { id: "auth", reason: "authentication, credentials and team identity", test: new RegExp(`(^|/)[^/]*(?:^|[-_.])(?:auth|credentials?|oauth|sso)(?:[-_.][^/]*)?\\.${ext}$`, "i") },
  { id: "scope", reason: "scope enforcement and source boundaries", test: /^packages\/engine\/src\/scope\/|(^|\/)(scope-path|scoped-source|source-scope|local-source-boundary|workflow-execution-policy)\.[a-z]+$/ },
  { id: "approvals", reason: "approval, decision and request-authorisation code", test: /(^|\/)(approvals?|decisions?)[^/]*\.[a-z]+$|^packages\/cli\/src\/web\/(console-gateway|team-web|dashboard-http|dashboard-api)\.ts$|^packages\/cli\/src\/commands\/dashboard\.ts$/ },
  { id: "session-store", reason: "session persistence, settings and migrations", test: /^packages\/cli\/src\/state\/(session-store|credential-store|settings)[^/]*\.ts$/ },
  { id: "supervisor-gates", reason: "supervisor, engine swap and the self-edit gate/launcher/panel code", test: /^packages\/engine\/src\/hub\/supervisor\.ts$|^packages\/cli\/src\/dev-engine-updates\.ts$|^packages\/cli\/src\/web\/self-edit[^/]*$|^packages\/web\/src\/lib\/self-edit-api\.ts$|^packages\/web\/src\/console\/panel\/views\/preview[^/]*$|^packages\/engine\/src\/agent\/skills\/techniques\/develop-this-app\.yaml$|^scripts\/(dev-web|build-dev-engine|check-architecture)[^/]*\.mjs$|^scripts\/config\// },
  { id: "dependencies", reason: "dependency manifests, lockfiles and build config (supply chain)", test: /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig[^/]*\.json|vitest\.config\.[a-z]+|vite\.config\.[a-z]+)$/ },
  { id: "ci", reason: "CI, hooks and agent instructions", test: /^\.github\/|^\.git[a-z]*(\/|$)|^\.husky\/|(^|\/)(AGENTS|CLAUDE)\.md$|^\.claude\/|^\.agents\// },
];

export interface ProtectedHit { path: string; rule: string; reason: string }
export interface ProtectedCheck { ok: boolean; files: string[]; hits: ProtectedHit[]; error?: string }

/** A path that is not plain and repository-relative could alias a rule, so it is itself a hit. */
function suspicious(path: string): boolean {
  return path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".");
}

export function checkProtectedPaths(files: readonly string[]): ProtectedCheck {
  const hits: ProtectedHit[] = [];
  for (const path of files) {
    if (suspicious(path)) { hits.push({ path, rule: "suspicious-path", reason: "path is not a plain repository-relative path" }); continue; }
    // Case-insensitive file systems alias differently-cased names, so match the lowercased path as well.
    const rule = PROTECTED_RULES.find(candidate => candidate.test.test(path) || candidate.test.test(path.toLowerCase()));
    if (rule) hits.push({ path, rule: rule.id, reason: rule.reason });
  }
  return { ok: hits.length === 0, files: [...files], hits };
}

/** Fail closed: a diff that could not be computed never passes. */
export function protectedCheckFailure(error: unknown): ProtectedCheck {
  return { ok: false, files: [], hits: [], error: error instanceof Error ? error.message : String(error) };
}
