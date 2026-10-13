/**
 * Zero formal-research campaign configuration.
 *
 * The former local checker was unsound: a candidate could put the intended
 * statement in a comment and prove True instead. Repeating the same compiler
 * also did not provide the independent checker required by the core contract.
 *
 * No checker is registered until isolated theorem comparison and independent
 * proof verification are available. Core preflight therefore stops before
 * model requests or candidate execution. Historical "checked" receipts from
 * this driver are not valid independently verified evidence.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runFormalResearchCampaign } from "../../packages/core/dist/research/formal-campaign.js";

const REPO = new URL("../../", import.meta.url).pathname;
const MODEL_SOURCE = readFileSync(join(REPO, "research/lean-replay/Replay.lean"), "utf8");
const TOOLCHAIN = "leanprover/lean4:v4.35.0-rc4";
const DEPENDENCY_LOCK = readFileSync(join(REPO, "research/lean-replay/lean-toolchain"), "utf8");

// Trusted model: definitions only, everything before the first theorem comment.
const DEFS_END = MODEL_SOURCE.indexOf("-- One ticket is accepted by both nodes");
if (DEFS_END < 0) throw new Error("Replay.lean marker not found");
const TRUSTED_MODEL = MODEL_SOURCE.slice(0, DEFS_END).trimEnd() + "\n";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

const STATEMENTS = {
  violation:
    "theorem independent_caches_accept_replay :\n" +
    "    (localConsume empty false 7).1 = true ∧\n" +
    "    (localConsume (localConsume empty false 7).2 true 7).1 = true",
  invariant:
    "theorem shared_cache_rejects_replay (seen : List Nat) (ticket : Nat) :\n" +
    "    (consume (consume seen ticket).2 ticket).1 = false",
};
const THEOREM_NAMES = {
  violation: "independent_caches_accept_replay",
  invariant: "shared_cache_rejects_replay",
};

function challenge(kind, claimPolarity) {
  return {
    claimId: `replay-${kind}`,
    claimPolarity,
    targetSourceRevision: "research/lean-replay@workspace",
    targetSourceDigest: sha256(MODEL_SOURCE),
    trustedStatement: STATEMENTS[kind],
    trustedStatementDigest: sha256(STATEMENTS[kind]),
    trustedModel: TRUSTED_MODEL,
    modelDigest: sha256(TRUSTED_MODEL),
    theoremName: THEOREM_NAMES[kind],
    toolchainVersion: TOOLCHAIN,
    dependencyLock: DEPENDENCY_LOCK,
    dependencyLockDigest: sha256(DEPENDENCY_LOCK),
  };
}


const KNOWN_PROOFS = {
  violation:
    `${STATEMENTS.violation} := by\n  decide\n`,
  invariant:
    "theorem consume_records_ticket (seen : List Nat) (ticket : Nat) :\n" +
    "    ticket ∈ (consume seen ticket).2 := by\n" +
    "  by_cases h : ticket ∈ seen <;> simp [consume, h]\n\n" +
    "theorem remembered_ticket_rejected (seen : List Nat) (ticket : Nat)\n" +
    "    (h : ticket ∈ seen) : (consume seen ticket).1 = false := by\n" +
    "  simp [consume, h]\n\n" +
    `${STATEMENTS.invariant} := by\n` +
    "  exact remembered_ticket_rejected _ ticket (consume_records_ticket seen ticket)\n",
};

function extractLean(text) {
  const fence = text.match(/```(?:lean4?|lean)?\s*\n([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim() + "\n";
}

async function llmGenerate(context) {
  const { challenge, attempt, previous, signal } = context;
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.DEMO_MODEL ?? "gpt-5.5";
  const prior = previous.length
    ? `\nPrevious attempts failed. Latest checker feedback:\n${previous[previous.length - 1].reason}\n`
    : "";
  const prompt =
    `Lean 4 toolchain ${TOOLCHAIN}, Std only (no Mathlib). Here are the trusted definitions:\n\n` +
    "```lean\n" + challenge.trustedModel + "```\n\n" +
    `Prove this exact theorem. Your reply must contain the theorem with this EXACT statement ` +
    `(whitespace may vary) followed by a complete proof:\n\n\`\`\`lean\n${challenge.trustedStatement}\n\`\`\`\n` +
    prior +
    `\nOutput a single lean code block containing only the theorem and its proof. ` +
    `Do not use 'sorry', 'native_decide', or new axioms.`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a Lean 4 proof engineer. You output only valid Lean 4 code." },
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Generator HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return { proof: extractLean(text) };
}

const generate = process.env.SELF_TEST === "1"
  ? context => Promise.resolve({ proof: KNOWN_PROOFS[context.challenge.claimId.replace("replay-", "")] })
  : llmGenerate;

// --- campaign ----------------------------------------------------------------

const result = await runFormalResearchCampaign({
  tasks: [
    { id: "violation", challenge: challenge("violation", "violation") },
    { id: "invariant", challenge: challenge("invariant", "invariant") },
  ],
  generate,
  verification: {
    checkerIdentity: "lean-comparator",
    checkerVersion: "unavailable",
    externalCheckerIdentity: "nanoda",
    externalCheckerVersion: "unavailable",
    timeoutMs: 120_000,
  },
  maxConcurrency: 2,
  maxAttemptsPerTask: 3,
  maxTotalAttempts: 8,
  timeCapMs: 300_000,
  artifactRoot: join(REPO, "research/formal-campaign/artifacts"),
});

console.log(JSON.stringify(result, (key, value) => key === "trustedModel" || key === "dependencyLock" ? undefined : value, 2));
if (result.tasks.some(task => task.status !== "checked")) process.exitCode = 2;
