/** Evidence projection of host-owned access-control artifacts.
 * Workflows prove transitions; only operator-owned read fixtures establish
 * restricted ownership. Never infer unauthorized access from a transition alone.
 * Never derive compromise from a finding title, category, severity or status.
 */
export interface AccessMilestone {
  key: string;
  asset: string;
  status: "conditional" | "confirmed" | "blocked";
  accessClass: "cross-identity-write" | "unauthorized-read";
  headline: string;
  summary: string;
  cleanup: "unknown" | "not-required";
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
      cleanup: "not-required", ...(evidenceEventId && evidenceEventId.length <= 512 ? { evidenceEventId } : {}) };
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
    summary: "The observing context saw the declared marker after requests using different configured authentication headers. Authorization impact requires validation. Cleanup was not verified.", cleanup: "unknown", ...(evidenceEventId && evidenceEventId.length <= 512 ? { evidenceEventId } : {}) };
}
/** Replay and polling deliver the same evidence repeatedly; first occurrence wins. */
export function appendAccessMilestone<T extends { milestone: AccessMilestone }>(current: readonly T[], next: T, limit = 80): T[] {
  const index = current.findIndex(item => item.milestone.key === next.milestone.key);
  if (index !== -1) {
    const rank = { blocked: 0, conditional: 1, confirmed: 2 };
    if (rank[next.milestone.status] <= rank[current[index].milestone.status]) return [...current];
    const updated = [...current]; updated[index] = next; return updated;
  }
  return [...current, next].slice(-Math.max(1, Math.min(80, limit)));
}
