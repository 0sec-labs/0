// Best-effort package identifier for a scan target.

/**
 * Derive a best-effort "package" identifier for a target. Used to match
 * memories with scope=package against incoming findings. For HTTP targets the
 * host is used; for filesystem targets the first path segment is used.
 */
export function inferPackage(target: string): string {
  const trimmed = target.trim();
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).host.toLowerCase();
    }
  } catch {
    // fall through
  }
  const first = trimmed.split(/[\/\\]/).filter((p) => p.length > 0)[0];
  return (first ?? trimmed).toLowerCase();
}
