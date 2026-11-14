export interface UpdateStatus { current: string; latest: string; url: string }

/** Normalize GET /api/console/update-status. Anything malformed or not newer yields null (no card). */
export function normalizeUpdateStatus(raw: unknown): UpdateStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.available !== true || typeof value.latest !== "string" || typeof value.current !== "string") return null;
  if (!/^\d+\.\d+\.\d+$/.test(value.latest)) return null;
  const url = typeof value.url === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases(?:\/|$)/.test(value.url) ? value.url : null;
  return url ? { current: value.current, latest: value.latest, url } : null;
}

/** A dismissal covers one version; the next release shows the card again. */
export function showUpdateCard(status: UpdateStatus | null, dismissedVersion: string): status is UpdateStatus {
  return status !== null && status.latest !== dismissedVersion;
}

export const UPDATE_COMMAND = "0 upgrade";
