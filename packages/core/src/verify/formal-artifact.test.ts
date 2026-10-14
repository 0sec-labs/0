import { describe, expect, it } from "vitest";
import {
  formalArtifactDigest as hash, formalChallengeDigest, verifyFormalArtifact,
  type FormalArtifactOptions, type FormalChallenge, type FormalCheckerRequest,
} from "./formal-artifact.js";

const challenge: FormalChallenge = {
  claimId: "replay-atomic", claimPolarity: "invariant",
  targetSourceRevision: "local-lab-v1", targetSourceDigest: hash("target"),
  trustedStatement: "atomic consume rejects the next replay", trustedStatementDigest: hash("atomic consume rejects the next replay"),
  trustedModel: "sequential atomic cache", modelDigest: hash("sequential atomic cache"),
  theoremName: "Replay.atomic_reject", toolchainVersion: "lean-4.pinned",
  dependencyLock: "Std pinned", dependencyLockDigest: hash("Std pinned"),
};
const candidate = { proof: "theorem Replay.atomic_reject := checked proof bytes" };
function receipt(request: FormalCheckerRequest) {
  const { trustedStatement: _statement, trustedModel: _model, dependencyLock: _lock, ...binding } = request.challenge;
  return {
    ...binding, invocationNonce: request.invocationNonce,
    challengeDigest: request.challengeDigest, proofDigest: request.proofDigest,
    checkerIdentity: "trusted-comparator", checkerVersion: "1",
    externalCheckerIdentity: "independent-kernel", externalCheckerVersion: "2",
    outcome: "checked", comparatorMatched: true, externalCheckerAccepted: true,
    axiomDependencies: ["propext", "Classical.choice", "Quot.sound"],
  };
}
const options: FormalArtifactOptions = {
  checkerIdentity: "trusted-comparator", checkerVersion: "1",
  externalCheckerIdentity: "independent-kernel", externalCheckerVersion: "2",
  checker: async request => receipt(request), timeoutMs: 100,
};

describe("formal artifact trust boundary", () => {
  it.each(["invariant", "violation"] as const)("retains %s polarity and only model scope", async claimPolarity => {
    const result = await verifyFormalArtifact({ ...challenge, claimPolarity }, candidate, options);
    expect(result).toMatchObject({ status: "checked", scope: "formal-model", claimPolarity });
    expect(result).not.toHaveProperty("findingVerdict");
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });
  it("gives checker frozen copies and full canonical challenge digest", async () => {
    const result = await verifyFormalArtifact(challenge, candidate, {
      ...options, checker: async request => {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.challenge)).toBe(true);
        expect(Object.isFrozen(request.candidate)).toBe(true);
        expect(request.challenge).not.toBe(challenge);
        expect(request.challengeDigest).toBe(formalChallengeDigest(challenge));
        return receipt(request);
      },
    });
    expect(result.status).toBe("checked");
  });
  it.each([
    "invocationNonce", "challengeDigest", "proofDigest", "claimId", "claimPolarity",
    "targetSourceRevision", "targetSourceDigest", "trustedStatementDigest", "modelDigest",
    "theoremName", "toolchainVersion", "dependencyLockDigest", "checkerIdentity", "checkerVersion",
    "externalCheckerIdentity", "externalCheckerVersion",
  ])("rejects swapped receipt binding %s", async key => {
    const result = await verifyFormalArtifact(challenge, candidate, {
      ...options, checker: async request => {
        const value = receipt(request);
        return { ...value, [key]: key === "invocationNonce" ? "00000000-0000-4000-8000-000000000000" : key === "claimPolarity" ? "violation" : key.endsWith("Digest") ? hash("swapped") : "swapped" };
      },
    });
    expect(result.status).toBe("artifact-rejected");
  });
  it.each(["sorryAx", "customAssumption", "Lean.ofReduceBool"])("rejects axiom %s", async axiom => {
    const result = await verifyFormalArtifact(challenge, candidate, {
      ...options, checker: async request => ({ ...receipt(request), axiomDependencies: [axiom] }),
    });
    expect(result.status).toBe("artifact-rejected");
  });
  it.each([
    (r: ReturnType<typeof receipt>) => { const { axiomDependencies: _audit, ...partial } = r; return partial; },
    (r: ReturnType<typeof receipt>) => ({ ...r, axiomDependencies: ["propext", "propext"] }),
    (r: ReturnType<typeof receipt>) => ({ ...r, unexpected: "candidate stdout" }),
    (_r: ReturnType<typeof receipt>) => "success: all proofs accepted",
    (_r: ReturnType<typeof receipt>) => ({ outcome: "checked" }),
    (r: ReturnType<typeof receipt>) => ({ ...r, comparatorMatched: false }),
  ])("rejects partial, forged, duplicate or noncorresponding receipts", async corrupt => {
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, checker: async r => corrupt(receipt(r)) })).status).toBe("artifact-rejected");
  });
  it.each(["trustedStatement", "trustedModel", "dependencyLock"])("rejects changed trusted %s bytes", async key => {
    expect((await verifyFormalArtifact({ ...challenge, [key]: "swapped" }, candidate, options)).status).toBe("artifact-rejected");
  });
  it("rejects unknown input fields and oversized UTF-8 proof bytes", async () => {
    expect((await verifyFormalArtifact({ ...challenge, unknown: true }, candidate, options)).status).toBe("artifact-rejected");
    expect((await verifyFormalArtifact(challenge, { ...candidate, receipt: "forged" }, options)).status).toBe("artifact-rejected");
    expect((await verifyFormalArtifact(challenge, { proof: "éé" }, { ...options, maxProofBytes: 3 })).status).toBe("artifact-rejected");
  });
  it("requires a fresh invocation receipt even for identical artifact bytes", async () => {
    let saved: unknown;
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, checker: async r => (saved = receipt(r)) })).status).toBe("checked");
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, checker: async () => saved })).status).toBe("artifact-rejected");
  });
  it("keeps missing checker and errors inconclusive", async () => {
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, checker: undefined })).status).toBe("inconclusive");
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, checker: async () => { throw new Error("failed"); } })).status).toBe("inconclusive");
  });
  it.each([{ outcome: "build-failed", comparatorMatched: false, externalCheckerAccepted: false }, { externalCheckerAccepted: false }])("keeps unsuccessful independent verification inconclusive", async patch => {
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, checker: async r => ({ ...receipt(r), ...patch }) })).status).toBe("inconclusive");
  });
  it("times out a stalled checker and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const result = await verifyFormalArtifact(challenge, candidate, {
      ...options, timeoutMs: 5, checker: async r => { signal = r.signal; return new Promise(() => {}); },
    });
    expect(result.status).toBe("inconclusive");
    expect(signal?.aborted).toBe(true);
  });
  it("propagates cancellation and never accepts the eventual receipt", async () => {
    const controller = new AbortController();
    const result = await verifyFormalArtifact(challenge, candidate, {
      ...options, signal: controller.signal, checker: async r => { controller.abort(); return receipt(r); },
    });
    expect(result.status).toBe("inconclusive");
  });
  it("never calls a checker for a pre-aborted operation", async () => {
    const controller = new AbortController(); controller.abort();
    let called = false;
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, signal: controller.signal, checker: async r => { called = true; return receipt(r); } })).status).toBe("inconclusive");
    expect(called).toBe(false);
  });
  it.each([0, Infinity, 120001, NaN])("rejects invalid finite timeout %s", async timeoutMs => {
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, timeoutMs })).status).toBe("artifact-rejected");
  });
  it("requires distinct comparator and independent checker identities", async () => {
    expect((await verifyFormalArtifact(challenge, candidate, { ...options, externalCheckerIdentity: options.checkerIdentity })).status).toBe("artifact-rejected");
  });
  it("snapshots checker configuration before invocation", async () => {
    const mutable = { ...options };
    mutable.checker = async r => {
      mutable.checkerIdentity = "swapped-during-check";
      return receipt(r);
    };
    expect((await verifyFormalArtifact(challenge, candidate, mutable)).status).toBe("checked");
  });
});
