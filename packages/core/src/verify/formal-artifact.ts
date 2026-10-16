import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(512);
const source = z.string().min(1).max(2_000_000);
const polarity = z.enum(["invariant", "violation"]);
const challengeSchema = z.object({
  claimId: name,
  claimPolarity: polarity,
  targetSourceRevision: name,
  targetSourceDigest: digest,
  trustedStatement: source,
  trustedStatementDigest: digest,
  trustedModel: source,
  modelDigest: digest,
  theoremName: name,
  toolchainVersion: name,
  dependencyLock: source,
  dependencyLockDigest: digest,
}).strict();
const candidateSchema = z.object({ proof: source }).strict();
const receiptSchema = z.object({
  invocationNonce: z.string().uuid(),
  challengeDigest: digest,
  proofDigest: digest,
  claimId: name,
  claimPolarity: polarity,
  targetSourceRevision: name,
  targetSourceDigest: digest,
  trustedStatementDigest: digest,
  modelDigest: digest,
  theoremName: name,
  toolchainVersion: name,
  dependencyLockDigest: digest,
  checkerIdentity: name,
  checkerVersion: name,
  externalCheckerIdentity: name,
  externalCheckerVersion: name,
  outcome: z.enum(["checked", "build-failed"]),
  comparatorMatched: z.boolean(),
  externalCheckerAccepted: z.boolean(),
  axiomDependencies: z.array(name).max(128),
}).strict();

export type FormalChallenge = Readonly<z.infer<typeof challengeSchema>>;
export type FormalProofCandidate = Readonly<z.infer<typeof candidateSchema>>;
export type FormalCheckerReceipt = Readonly<z.infer<typeof receiptSchema>>;
export interface FormalCheckerRequest {
  readonly challenge: FormalChallenge;
  readonly candidate: FormalProofCandidate;
  readonly challengeDigest: string;
  readonly proofDigest: string;
  readonly invocationNonce: string;
  readonly signal: AbortSignal;
}
/**
 * Trusted infrastructure injection, never a candidate-supplied callback or stdout
 * parser. Implementations must isolate generated code, enforce resource/network
 * limits, and run the Comparator plus an independent external proof checker.
 * Hashes bind artifacts; authenticity comes from this trusted channel.
 */
export type FormalArtifactChecker = (request: FormalCheckerRequest) => Promise<unknown>;
export interface FormalArtifactOptions {
  checker?: FormalArtifactChecker;
  checkerIdentity: string;
  checkerVersion: string;
  externalCheckerIdentity: string;
  externalCheckerVersion: string;
  timeoutMs?: number;
  maxProofBytes?: number;
  signal?: AbortSignal;
}
export interface FormalArtifactResult {
  readonly status: "checked" | "artifact-rejected" | "inconclusive";
  readonly scope: "formal-model";
  readonly reason: string;
  readonly claimPolarity?: "invariant" | "violation";
  readonly challengeDigest?: string;
  readonly proofDigest?: string;
  readonly receipt?: FormalCheckerReceipt;
}

export function formalArtifactDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Fixed-field canonical serialization includes the complete trusted challenge. */
export function formalChallengeDigest(challenge: FormalChallenge): string {
  return formalArtifactDigest(JSON.stringify(challengeSchema.parse(challenge)));
}

const STANDARD_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const optionsSchema = z.object({
  checker: z.custom<FormalArtifactChecker>(value => typeof value === "function").optional(),
  checkerIdentity: name,
  checkerVersion: name,
  externalCheckerIdentity: name,
  externalCheckerVersion: name,
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
  maxProofBytes: z.number().int().min(1).max(2_000_000).optional(),
  signal: z.instanceof(AbortSignal).optional(),
}).strict();

/** A checked model result does not confirm a target bug or reject a finding. */
export async function verifyFormalArtifact(
  trustedChallenge: unknown,
  proposedCandidate: unknown,
  inputOptions: FormalArtifactOptions,
): Promise<FormalArtifactResult> {
  const rejected = (reason: string): FormalArtifactResult => ({ status: "artifact-rejected", scope: "formal-model", reason });
  const parsedOptions = optionsSchema.safeParse(inputOptions);
  if (!parsedOptions.success) return rejected("Invalid checker configuration or finite budget");
  const options = Object.freeze(parsedOptions.data);
  if (options.checkerIdentity === options.externalCheckerIdentity) return rejected("Comparator and independent checker must have distinct identities");
  const parsedChallenge = challengeSchema.safeParse(trustedChallenge);
  const parsedCandidate = candidateSchema.safeParse(proposedCandidate);
  if (!parsedChallenge.success || !parsedCandidate.success) return rejected("Invalid challenge or proof candidate schema");
  const challenge = Object.freeze(parsedChallenge.data);
  const candidate = Object.freeze(parsedCandidate.data);
  if (formalArtifactDigest(challenge.trustedStatement) !== challenge.trustedStatementDigest ||
      formalArtifactDigest(challenge.trustedModel) !== challenge.modelDigest ||
      formalArtifactDigest(challenge.dependencyLock) !== challenge.dependencyLockDigest) {
    return rejected("Trusted content digest mismatch");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxProofBytes = options.maxProofBytes ?? 1_000_000;
  if (Buffer.byteLength(candidate.proof, "utf8") > maxProofBytes ||
      [challenge.trustedStatement, challenge.trustedModel, challenge.dependencyLock].some(x => Buffer.byteLength(x, "utf8") > 2_000_000)) {
    return rejected("Artifact exceeds byte budget");
  }
  const challengeDigest = formalChallengeDigest(challenge);
  const proofDigest = formalArtifactDigest(candidate.proof);
  const base = { scope: "formal-model" as const, claimPolarity: challenge.claimPolarity, challengeDigest, proofDigest };
  const inconclusive = (reason: string): FormalArtifactResult => ({ ...base, status: "inconclusive", reason });
  const rejectBound = (reason: string): FormalArtifactResult => ({ ...base, status: "artifact-rejected", reason });
  if (!options.checker) return inconclusive("Trusted independent checker unavailable");
  if (options.signal?.aborted) return inconclusive("Cancelled");
  const controller = new AbortController();
  const invocationNonce = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const stop = new Promise<never>((_, reject) => {
      abortListener = () => { controller.abort(); reject(new Error("Cancelled")); };
      options.signal?.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new Error("Checker timed out")); }, timeoutMs);
    });
    const rawReceipt = await Promise.race([
      Promise.resolve().then(() => options.checker!(Object.freeze({ challenge, candidate, challengeDigest, proofDigest, invocationNonce, signal: controller.signal }))),
      stop,
    ]);
    if (controller.signal.aborted || options.signal?.aborted) return inconclusive("Cancelled");
    const parsed = receiptSchema.safeParse(rawReceipt);
    if (!parsed.success) return rejectBound("Invalid or incomplete trusted checker receipt");
    const receipt = parsed.data;
    const expected = {
      invocationNonce, challengeDigest, proofDigest,
      claimId: challenge.claimId, claimPolarity: challenge.claimPolarity,
      targetSourceRevision: challenge.targetSourceRevision, targetSourceDigest: challenge.targetSourceDigest,
      trustedStatementDigest: challenge.trustedStatementDigest, modelDigest: challenge.modelDigest,
      theoremName: challenge.theoremName, toolchainVersion: challenge.toolchainVersion,
      dependencyLockDigest: challenge.dependencyLockDigest,
      checkerIdentity: options.checkerIdentity, checkerVersion: options.checkerVersion,
      externalCheckerIdentity: options.externalCheckerIdentity, externalCheckerVersion: options.externalCheckerVersion,
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (receipt[key] !== expected[key]) return rejectBound(`Checker receipt binding mismatch: ${key}`);
    }
    if (new Set(receipt.axiomDependencies).size !== receipt.axiomDependencies.length ||
        receipt.axiomDependencies.some(axiom => !STANDARD_AXIOMS.has(axiom))) return rejectBound("Disallowed or duplicate axiom dependency");
    if (receipt.outcome === "build-failed") return inconclusive("Proof build failed");
    if (!receipt.comparatorMatched) return rejectBound("Comparator rejected exact trusted theorem correspondence");
    if (!receipt.externalCheckerAccepted) return inconclusive("Independent checker did not verify proof");
    Object.freeze(receipt.axiomDependencies);
    return { ...base, status: "checked", reason: "Exact theorem independently checked in the trusted formal model", receipt: Object.freeze(receipt) };
  } catch {
    return inconclusive(controller.signal.aborted ? "Checker timed out or cancelled" : "Trusted checker failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    controller.abort();
  }
}
