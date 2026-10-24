import { createHash, randomUUID } from "node:crypto";
import type { AccessControlFixture } from "@0/shared";

export const stateDigest = (value: unknown): string => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface StateAccessProof {
  schema: "0.state-access-proof/v1";
  authority: "operator-fixture";
  access_class: "unauthorized-write";
  status: "confirmed";
  challenge_bound: true;
  proof_id: string;
  fixture_digest: string;
  baseline_digest: string;
  observed_digest: string;
  cleanup: "required" | "completed" | "failed";
  verified_at: number;
  generation: number;
  cleanup_revision: number;
  cleanup_at?: number;
  evidence_event_id?: string;
}
export function stateContract(fixtures: AccessControlFixture[] | undefined, url: string, owner: string, actor?: string, pointer?: string) {
  return fixtures?.find(fixture => {
    try { const observation = new URL(url); return !observation.username && !observation.password && new URL(fixture.url).href === observation.href && fixture.ownerIdentity === owner
      && fixture.stateChange?.disposable === true && typeof fixture.ownershipMarker === "string"
      && fixture.ownershipMarker.length >= 16 && fixture.ownershipMarker.length <= 500 && Array.isArray(fixture.stateChange.stepUrls)
      && fixture.stateChange.stepUrls.length > 0 && fixture.stateChange.stepUrls.length <= 10
      && fixture.stateChange.stepUrls.every(step => { const parsed = new URL(step), observed = new URL(url); return parsed.origin === observed.origin && !parsed.username && !parsed.password; })
      && (!actor || fixture.comparisonIdentities.includes(actor))
      && (pointer === undefined || fixture.stateChange.jsonPointer === pointer); } catch { return false; }
  });
}
export function stateFixtureDigest(fixture: AccessControlFixture): string {
  return stateDigest({ url: new URL(fixture.url).href, owner: fixture.ownerIdentity,
    actors: [...new Set(fixture.comparisonIdentities)].sort(), marker: stateDigest(fixture.ownershipMarker),
    stateChange: fixture.stateChange ? { disposable: true, jsonPointer: fixture.stateChange.jsonPointer,
      stepUrls: [...new Set(fixture.stateChange.stepUrls.map(url => new URL(url).href))].sort() } : undefined });
}
/** Only already persisted host receipts are accepted; callers never supply a proof. */
export function latestStateProof(events: { payload: string; id?: string | number }[], fixture: AccessControlFixture): StateAccessProof | undefined {
  const digest = stateFixtureDigest(fixture);
  const valid: StateAccessProof[] = [];
  for (const event of events) {
    try {
      const artifact = JSON.parse(event.payload);
      if (!["access_control_workflow", "access_control_cleanup"].includes(artifact.tool)) continue;
      const proof = artifact.state_access_proof as StateAccessProof | undefined;
      if (proof?.schema === "0.state-access-proof/v1" && proof.authority === "operator-fixture"
        && proof.fixture_digest === digest && proof.status === "confirmed" && proof.challenge_bound === true && proof.access_class === "unauthorized-write"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(proof.proof_id) && /^sha256:[a-f0-9]{64}$/.test(proof.baseline_digest)
        && /^sha256:[a-f0-9]{64}$/.test(proof.observed_digest) && Number.isFinite(proof.verified_at)
        && Number.isSafeInteger(proof.generation) && proof.generation > 0
        && Number.isSafeInteger(proof.cleanup_revision) && proof.cleanup_revision >= 0
        && ["required", "completed", "failed"].includes(proof.cleanup)) valid.push({ ...proof,
          ...(proof.evidence_event_id ? {} : event.id !== undefined ? { evidence_event_id: String(event.id) } : {}) });
    } catch { /* Invalid retained records never become authority. */ }
  }
  return valid.sort((a, b) => b.generation - a.generation || b.cleanup_revision - a.cleanup_revision || b.verified_at - a.verified_at)[0];
}
export function confirmedStateProof(fixture: AccessControlFixture, input: {
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  steps: Record<string, unknown>[]; expected: string; prior?: StateAccessProof; now: number; challengeIssued: boolean;
}): StateAccessProof | null {
  const complete = (observation: Record<string, unknown> | null) => observation && typeof observation.status === "number"
    && observation.status >= 200 && observation.status < 300 && observation.truncated === false
    && observation.field_present === true && observation.value_truncated !== true && observation.redacted === false
    && ["string", "null"].includes(String(observation.value_type)) && (typeof observation.json_pointer_value === "string" || observation.json_pointer_value === null);
  if (!fixture.stateChange || !complete(input.before) || !complete(input.after)
    || input.before!.json_pointer_value === input.expected || input.after!.json_pointer_value !== input.expected
    || !input.steps.length || input.steps.length > 10
    || !input.steps.some(step => ["POST", "PUT", "PATCH"].includes(String(step.method)) && step.request_marker_sent === true)
    || input.steps.some(step => step.error !== undefined || typeof step.status !== "number" || !Number.isInteger(step.status)
      || step.status < 100 || step.status > 599 || !["GET", "POST", "PUT", "PATCH"].includes(String(step.method))
      || !fixture.stateChange!.stepUrls.some(url => { try { return new URL(url).href === new URL(String(step.url)).href; } catch { return false; } }))) return null;
  const after = stateDigest(input.after!.json_pointer_value);
  if (input.prior && input.prior.cleanup !== "completed" && after === input.prior.baseline_digest) {
    return { ...input.prior, cleanup: "completed", cleanup_at: input.now, cleanup_revision: input.prior.cleanup_revision + 1 };
  }
  if (!input.challengeIssued || !/^zero-state-[a-f0-9-]{36}$/.test(input.expected)) return null;
  return { schema: "0.state-access-proof/v1", authority: "operator-fixture", access_class: "unauthorized-write",
    status: "confirmed", challenge_bound: true, proof_id: randomUUID(), fixture_digest: stateFixtureDigest(fixture),
    baseline_digest: stateDigest(input.before!.json_pointer_value), observed_digest: after,
    cleanup: "required", verified_at: input.now, generation: (input.prior?.generation ?? 0) + 1, cleanup_revision: 0 };
}
/** Pointer traversal has no prototype lookup, coercion or implicit array indexing. */
export function observedState(body: string, pointer: string): string | null {
  let value: unknown = JSON.parse(body);
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)
      || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))) throw new Error("Observation field missing");
    value = (value as Record<string, unknown>)[key];
  }
  if (value !== null && (typeof value !== "string" || value.length > 500)) throw new Error("Observation field is not a bounded marker");
  return value;
}
