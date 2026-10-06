/** Evidence projection of the host-owned access_control_workflow artifact.
 * This proves a cross-identity transition, NOT that the actor lacked permission.
 * Never derive compromise from a finding title, category, severity or status.
 */
export interface AccessMilestone {
  key: string;
  asset: string;
  status: "conditional";
  accessClass: "cross-identity-write";
  headline: "State change confirmed across request contexts";
  summary: string;
  cleanup: "unknown";
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
  if (current.some(item => item.milestone.key === next.milestone.key)) return [...current];
  return [...current, next].slice(-Math.max(1, Math.min(80, limit)));
}
