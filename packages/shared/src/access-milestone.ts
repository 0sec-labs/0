/** Evidence projection of host-owned access-control artifacts.
 * Workflows prove transitions; only operator-owned read fixtures establish
 * restricted ownership. Never infer unauthorized access from a transition alone.
 * Never derive compromise from a finding title, category, severity or status.
 */
export interface AccessMilestone {
  key: string;
  asset: string;
  status: "conditional" | "confirmed" | "blocked";
  accessClass: "cross-identity-write" | "unauthorized-read" | "unauthorized-write";
  headline: string;
  summary: string;
  cleanup: "unknown" | "not-required" | "required" | "completed" | "failed";
  confidence?: number;
  severity?: "info" | "high" | "unassessed";
  accessLevel?: string;
  prerequisites?: string[];
  limitations?: string[];
  verifiedAt?: number;
  cleanupAt?: number;
  cleanupEvidenceEventId?: string;
  proofId?: string;
  proofGeneration?: number;
  cleanupRevision?: number;
  evidenceEventId?: string;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const successfulObservation = (value: unknown) => {
  const item = record(value);
  return item && typeof item.status === "number" && Number.isInteger(item.status) && item.status >= 200 && item.status < 300
    && item.truncated === false && item.field_present === true && (typeof item.json_pointer_value === "string" || item.json_pointer_value === null) ? item : undefined;
};
export function accessMilestoneFromArtifact(eventType: string, value: unknown, scopeId: string, evidenceEventId?: string): AccessMilestone | null {
  const item = record(value);
  if (eventType === "tool_artifact" && item && ["access_control_workflow", "access_control_cleanup"].includes(String(item.tool)) && item.state_access_proof !== undefined) {
    const proof = record(item.state_access_proof);
    const digest = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
    const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
    if (!proof || proof.schema !== "0.state-access-proof/v1" || proof.authority !== "operator-fixture"
      || proof.access_class !== "unauthorized-write" || proof.status !== "confirmed" || proof.challenge_bound !== true
      || typeof proof.proof_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(proof.proof_id)
      || !digest(proof.fixture_digest) || !digest(proof.baseline_digest) || !digest(proof.observed_digest)
      || !timestamp(proof.verified_at) || !Number.isSafeInteger(proof.generation) || Number(proof.generation) < 1
      || !Number.isSafeInteger(proof.cleanup_revision) || Number(proof.cleanup_revision) < 0
      || !["required", "completed", "failed"].includes(String(proof.cleanup))
      || (proof.cleanup !== "required" && !timestamp(proof.cleanup_at))
      || typeof item.observation_url !== "string" || item.observation_url.length > 8192 || !scopeId || scopeId.length > 512) return null;
    if (item.tool === "access_control_workflow") {
      const before = successfulObservation(item.observation_before), after = successfulObservation(item.observation_after);
      const steps = item.steps;
      if (item.verdict !== "confirmed" || !before || !after || before.redacted !== false || after.redacted !== false
        || before.value_truncated === true || after.value_truncated === true
        || before.json_pointer_value === after.json_pointer_value || after.json_pointer_value !== item.expected_state
        || !Array.isArray(steps) || !steps.length || steps.length > 10
        || !steps.some(value => { const step = record(value); return step?.request_marker_sent === true && ["POST", "PUT", "PATCH"].includes(String(step.method)); })
        || steps.some(value => { const step = record(value); return !step || typeof step.status !== "number" || !Number.isInteger(step.status) || step.status < 100 || step.status > 599 || step.error !== undefined; })) return null;
    }
    if (item.tool === "access_control_cleanup") {
      const observation = record(item.observation);
      if (!observation || typeof observation.status !== "number" || observation.status < 200 || observation.status >= 300
        || observation.truncated !== false || !digest(observation.value_digest)
        || ((observation.value_digest === proof.baseline_digest) !== (proof.cleanup === "completed"))) return null;
    }
    let asset: string;
    try { const url = new URL(item.observation_url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null; asset = url.origin; } catch { return null; }
    const originalId = typeof proof.evidence_event_id === "string" && proof.evidence_event_id.length <= 512 ? proof.evidence_event_id : evidenceEventId;
    return { key: JSON.stringify([scopeId, "unauthorized-write", item.observation_url]), asset,
      status: "confirmed", accessClass: "unauthorized-write", headline: "Unauthorized state change confirmed",
      summary: "A configured comparison identity changed the observed field of an operator-declared restricted disposable resource. Verification observed the new marker using the owner's request context.",
      cleanup: proof.cleanup as "required" | "completed" | "failed", confidence: 1, severity: "unassessed", accessLevel: "Resource write",
      prerequisites: ["Operator-declared restricted disposable resource", "Fresh private synthetic marker", "Distinct configured owner and comparison credentials"],
      limitations: ["The proof covers only the configured resource and observed field. Cleanup checks that field only; other side effects, shell access and broader privileges are not established."],
      verifiedAt: proof.verified_at as number, proofId: proof.proof_id, proofGeneration: proof.generation as number, cleanupRevision: proof.cleanup_revision as number, ...(proof.cleanup_at !== undefined ? { cleanupAt: proof.cleanup_at as number } : {}),
      ...(originalId ? { evidenceEventId: originalId } : {}),
      ...(proof.cleanup !== "required" && evidenceEventId ? { cleanupEvidenceEventId: evidenceEventId } : {}) };
  }
  if (eventType === "tool_artifact" && item?.tool === "access_control_probe") {
    const proof = record(item.access_proof);
    if (!proof || proof.schema !== "0.access-proof/v1" || proof.authority !== "operator-fixture"
      || proof.access_class !== "unauthorized-read" || !["confirmed", "blocked"].includes(String(proof.status))
      || proof.owner_marker_observed !== true || proof.cleanup !== "not-required"
      || typeof proof.baseline_status !== "number" || !Number.isInteger(proof.baseline_status)
      || proof.baseline_status < 200 || proof.baseline_status >= 300
      || proof.comparison_marker_observed !== (proof.status === "confirmed")
      || item.method !== "GET" || typeof item.url !== "string" || item.url.length > 8192
      || !scopeId || scopeId.length > 512) return null;
    const baseline = record(proof.baseline_observation);
    const observations = proof.comparison_observations;
    const validObservation = (value: unknown) => { const observation = record(value); return observation
      && typeof observation.status === "number" && Number.isInteger(observation.status)
      && observation.truncated === false && typeof observation.marker_observed === "boolean"
      && typeof observation.response_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(observation.response_digest); };
    if (!validObservation(baseline) || baseline!.status !== proof.baseline_status || baseline!.marker_observed !== true
      || !Array.isArray(observations) || !observations.length || observations.length > 16
      || !observations.every(validObservation)) return null;
    if (proof.status === "confirmed" ? !observations.some(value => { const o = record(value)!; return Number(o.status) >= 200 && Number(o.status) < 300 && o.marker_observed === true; })
      : !observations.every(value => { const o = record(value)!; return [401, 403].includes(Number(o.status)) && o.marker_observed === false; })) return null;
    let asset: string;
    try { const url = new URL(item.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null; asset = url.origin; }
    catch { return null; }
    const confirmed = proof.status === "confirmed";
    return { key: JSON.stringify([scopeId, "unauthorized-read", item.url]), asset,
      status: confirmed ? "confirmed" : "blocked", accessClass: "unauthorized-read",
      headline: confirmed ? "Unauthorized resource read confirmed" : "Unauthorized resource read blocked",
      summary: confirmed
        ? "A comparison identity retrieved the private owner marker from an operator-declared restricted resource. This read-only proof required no cleanup. The result applies to the configured ownership contract."
        : "The configured comparison identities were denied access to the operator-declared restricted resource. This read-only test required no cleanup.",
      cleanup: "not-required", confidence: 1, severity: confirmed ? "unassessed" : "info", accessLevel: confirmed ? "Resource read" : "Access denied",
      prerequisites: ["Operator-declared ownership contract"], limitations: ["The result covers only the configured resource and tested identities."], ...(evidenceEventId && evidenceEventId.length <= 512 ? { evidenceEventId } : {}) };
  }
  if (eventType !== "tool_artifact" || !item || item.tool !== "access_control_workflow"
    || item.workflow !== "access_control_workflow" || item.verdict !== "confirmed"
    || typeof item.owner_identity !== "string" || !item.owner_identity
    || typeof item.actor_identity !== "string" || !item.actor_identity || item.owner_identity === item.actor_identity
    || typeof item.expected_state !== "string" || item.expected_state.length > 500
    || typeof item.observation_url !== "string" || item.observation_url.length > 8192 || !scopeId || scopeId.length > 512) return null;
  const before = successfulObservation(item.observation_before);
  const after = successfulObservation(item.observation_after);
  if (!before || !after || before.json_pointer_value === item.expected_state || after.json_pointer_value !== item.expected_state
    || !Array.isArray(item.steps) || item.steps.length === 0 || item.steps.length > 10) return null;
  if (item.steps.some((value, index) => {
    const step = record(value);
    return !step || step.step_index !== index || typeof step.url !== "string"
      || !["GET", "POST", "PUT", "DELETE", "PATCH"].includes(String(step.method))
      || typeof step.status !== "number" || !Number.isInteger(step.status) || step.status < 100 || step.status > 599 || step.error !== undefined;
  })) return null;
  // Screenshot-safe asset label: origin only; paths/query/markers may be secrets.
  let asset: string;
  try {
    const url = new URL(item.observation_url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    asset = url.origin;
  } catch { return null; }
  return { key: JSON.stringify([scopeId, "cross-identity-write", item.observation_url]), asset,
    status: "conditional", accessClass: "cross-identity-write", headline: "State change confirmed across request contexts",
    summary: "The observing context saw the declared marker after requests using different configured authentication headers. Authorization impact requires validation. Cleanup was not verified.", cleanup: "unknown", confidence: 1, severity: "info", accessLevel: "Observed state transition",
    prerequisites: ["Distinct configured authentication headers"], limitations: ["Authorization impact and cleanup are unverified."], ...(evidenceEventId && evidenceEventId.length <= 512 ? { evidenceEventId } : {}) };
}
/** Replay and polling deliver the same evidence repeatedly; first occurrence wins. */
export function appendAccessMilestone<T extends { milestone: AccessMilestone }>(current: readonly T[], next: T, limit = 80): T[] {
  const index = current.findIndex(item => item.milestone.key === next.milestone.key);
  if (index !== -1) {
    const rank = { blocked: 0, conditional: 1, confirmed: 2 };
    const previous = current[index].milestone;
    const sameProof = next.milestone.proofId !== undefined && next.milestone.proofId === previous.proofId;
    const newerCleanup = sameProof && next.milestone.cleanup !== previous.cleanup
      && (next.milestone.cleanupRevision ?? -1) > (previous.cleanupRevision ?? -1);
    const newerProof = next.milestone.proofId !== undefined && next.milestone.proofId !== previous.proofId
      && (next.milestone.verifiedAt ?? -1) >= (previous.verifiedAt ?? -1)
      && ((next.milestone.proofGeneration ?? 0) > (previous.proofGeneration ?? 0) || (next.milestone.verifiedAt ?? -1) > (previous.verifiedAt ?? -1));
    if (rank[next.milestone.status] <= rank[previous.status] && !newerCleanup && !newerProof) return [...current];
    const updated = [...current]; updated[index] = next; return updated;
  }
  const appended = [...current, next];
  const cap = Math.max(1, Math.min(80, Number.isFinite(limit) ? Math.floor(limit) : 80));
  if (appended.length <= cap) return appended;
  const retained = new Set(visibleAccessMilestones(appended, cap));
  return appended.filter(item => retained.has(item));
}

/** Prominent summaries retain the strongest proof when newer lower-impact events arrive. */
export function visibleAccessMilestones<T extends { milestone: AccessMilestone }>(items: readonly T[], limit = 3): T[] {
  const impact = (milestone: AccessMilestone) => milestone.status === "confirmed"
    ? milestone.accessClass === "unauthorized-write" ? 4 : 3 : milestone.status === "conditional" ? 1 : 0;
  return items.map((item, index) => ({ item, index })).sort((a, b) => impact(b.item.milestone) - impact(a.item.milestone) || b.index - a.index)
    .slice(0, Math.max(1, Math.min(80, Number.isFinite(limit) ? Math.floor(limit) : 3))).map(entry => entry.item);
}
