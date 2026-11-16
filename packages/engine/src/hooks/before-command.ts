/**
 * `beforeCommand`: the one decision point for commands and network targets.
 *
 * Every bash command, every network target a core tool opens and every file write
 * outside the workspace is put through the same hook before it runs. The answer is
 * `allow`, `deny(reason)` or `ask(reason)`. Combination: any deny wins, then any ask,
 * else allow. A policy that throws, rejects or times out counts as deny.
 *
 * Only first-party built-ins register a policy (see `builtin-policies.ts`); there is
 * deliberately no public registration API, so a plugin cannot loosen scope
 * (docs/design/one-extension-system.md section 3, open question 3).
 */
/** The part of a scope policy the hook needs; `ScopePolicy` satisfies it. */
export interface BeforeCommandScope {
  match(url: string): { readonly allowed: boolean; readonly reason: string };
  readonly raw: { readonly out_of_scope?: readonly string[] };
}

/**
 * What the call does: `bash` runs shell text, `process` starts a program or feeds a running one, `network` reaches a
 * host, `file-write` changes files, `file-read` reads them (never needs operator approval).
 */
export type BeforeCommandKind = "bash" | "network" | "file-write" | "process" | "file-read";

/** Who is running the command, and the scope that applies to it (undefined = none defined). */
export interface BeforeCommandThread {
  readonly id?: string;
  /** Host scope defined for this thread/run (project, --scope, Agent, automation, PR checkout). */
  readonly scope?: BeforeCommandScope;
  /** http_audit path allowlist prefixes, when defined. */
  readonly pathPrefixes?: readonly string[];
  /** The global "Ask before running commands" setting. */
  readonly approvals?: "ask" | "auto";
  /** An interactive channel can approve a scope that does not cover a target yet. */
  readonly canAskScope?: boolean;
}

export interface BeforeCommandInput {
  readonly kind: BeforeCommandKind;
  /** The command text, or a one-line description for non-bash targets. */
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Full URLs (or bare hosts) the command or tool is going to reach. */
  readonly hosts: readonly string[];
  readonly paths: readonly string[];
  readonly thread: BeforeCommandThread;
  /** False for reads and other calls that never need operator approval (default true). */
  readonly effectful?: boolean;
}

export type BeforeCommandDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string }
  | { readonly decision: "ask"; readonly reason: string };

export interface BeforeCommandPolicy {
  readonly id: string;
  evaluate(input: BeforeCommandInput): BeforeCommandDecision | Promise<BeforeCommandDecision>;
}

export interface BeforeCommandOutcome {
  readonly decision: "allow" | "deny" | "ask";
  /** Reason of the winning decision (first deny, else first ask). */
  readonly reason: string;
  readonly denies: readonly { readonly policyId: string; readonly reason: string }[];
  readonly asks: readonly { readonly policyId: string; readonly reason: string }[];
}

export const BEFORE_COMMAND_TIMEOUT_MS = 5_000;

const ALLOW: BeforeCommandOutcome = Object.freeze({ decision: "allow", reason: "", denies: [], asks: [] });

async function runPolicy(policy: BeforeCommandPolicy, input: BeforeCommandInput, timeoutMs: number): Promise<BeforeCommandDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const result = await Promise.race([Promise.resolve().then(() => policy.evaluate(input)), timeout]);
    if (result && (result.decision === "allow" || result.decision === "deny" || result.decision === "ask")) return result;
    return { decision: "deny", reason: `${policy.id} returned an invalid decision (fail closed)` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { decision: "deny", reason: `${policy.id} failed: ${detail} (fail closed)` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Combine every policy's answer: any deny wins, then any ask, else allow. */
export async function evaluateBeforeCommand(
  input: BeforeCommandInput,
  policies: readonly BeforeCommandPolicy[],
  timeoutMs = BEFORE_COMMAND_TIMEOUT_MS,
): Promise<BeforeCommandOutcome> {
  if (policies.length === 0) return ALLOW;
  const answers = await Promise.all(policies.map(async (policy) => ({ policyId: policy.id, answer: await runPolicy(policy, input, timeoutMs) })));
  const denies: { policyId: string; reason: string }[] = [];
  const asks: { policyId: string; reason: string }[] = [];
  for (const { policyId, answer } of answers) {
    if (answer.decision === "deny") denies.push({ policyId, reason: answer.reason });
    else if (answer.decision === "ask") asks.push({ policyId, reason: answer.reason });
  }
  if (denies.length) return { decision: "deny", reason: denies[0].reason, denies, asks };
  if (asks.length) return { decision: "ask", reason: asks[0].reason, denies, asks };
  return ALLOW;
}
