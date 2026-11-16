import type { BeforeCommandScope, BeforeCommandDecision, BeforeCommandInput, BeforeCommandPolicy } from "../hooks/before-command.js";
import { isAbsolute, resolve, sep } from "node:path";
import { realpathLoose } from "../hooks/real-path.js";
import { SCOPE_PLUGIN_ID } from "../plugins/builtin.js";
import { getScopeEnforcementState } from "./activation.js";
import { PathPolicy } from "./enforcement.js";
import { getLocalSourceBoundary } from "./local-source-boundary.js";
import { ScopePolicy, extractUrls } from "./scope.js";

function urlsOf(input: BeforeCommandInput): string[] {
  const urls = new Set<string>();
  for (const host of input.hosts) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) urls.add(host);
    else if (host.trim()) urls.add(`https://${host.trim()}`);
  }
  // Every kind carries its command text (bash, process, network, file-write); hosts are read from all of them.
  if (input.kind !== "file-read") for (const url of extractUrls(input.command)) urls.add(url);
  return [...urls];
}

/** A path (or the working directory) outside the explicit local source folder, when one bounds this run. */
function outsideLocalRoot(input: BeforeCommandInput): string | null {
  const root = getLocalSourceBoundary();
  if (!root) return null;
  for (const candidate of [input.cwd, ...input.paths]) {
    if (!candidate) continue;
    const abs = realpathLoose(isAbsolute(candidate) ? resolve(candidate) : resolve(input.cwd, candidate));
    if (abs !== root && !abs.startsWith(root + sep)) return candidate;
  }
  return null;
}

/** A rule in out_of_scope matches: this is an exclusion, which no approval may override. */
function isExcluded(scope: BeforeCommandScope, url: string): boolean {
  const exclusions = scope.raw.out_of_scope ?? [];
  if (exclusions.length === 0) return false;
  return !ScopePolicy.fromJson({ in_scope: [new URL(url).hostname], out_of_scope: [...exclusions] }).match(url).allowed;
}

/**
 * First-party `scope` policy for `beforeCommand`. On by default, fail closed:
 * with no scope defined it allows; with a scope defined it enforces; with a scope
 * defined and the plugin disabled it denies. The existing matchers (`ScopePolicy`,
 * `PathPolicy`) do the work.
 *
 * Known gap (documented, tested): the check is textual. A host built from a
 * variable, base64 or a temp file inside a bash command is not visible here.
 */
export const scopeBeforeCommandPolicy: BeforeCommandPolicy = {
  id: SCOPE_PLUGIN_ID,
  evaluate(input: BeforeCommandInput): BeforeCommandDecision {
    const { scope, pathPrefixes } = input.thread;
    const defined = scope !== undefined || (pathPrefixes?.length ?? 0) > 0;
    // An explicit local source folder bounds paths and the working directory whether or not a host scope exists.
    const outside = outsideLocalRoot(input);
    if (outside) return { decision: "deny", reason: `path '${outside}' is outside the local source folder this run is limited to` };
    const state = getScopeEnforcementState(input.cwd, undefined, defined);
    if (state.denied) return { decision: "deny", reason: state.message };
    if (!defined || !state.enabled) return { decision: "allow" };
    const paths = pathPrefixes?.length ? new PathPolicy([...pathPrefixes]) : undefined;

    const uncovered: string[] = [];
    for (const url of urlsOf(input)) {
      const pathVerdict = paths?.match(url);
      if (pathVerdict && !pathVerdict.allowed) {
        return { decision: "deny", reason: `command references out-of-path URL '${url}' (${pathVerdict.reason})` };
      }
      if (!scope) continue;
      const verdict = scope.match(url);
      if (verdict.allowed) continue;
      const reason = `command references out-of-scope URL '${url}' (${verdict.reason})`;
      let excluded = false;
      try { excluded = isExcluded(scope, url); } catch { excluded = true; }
      if (excluded || !input.thread.canAskScope) return { decision: "deny", reason };
      uncovered.push(url);
    }
    if (uncovered.length) return { decision: "ask", reason: `scope does not cover ${uncovered.join(", ")}` };
    return { decision: "allow" };
  },
};
