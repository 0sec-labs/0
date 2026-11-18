/**
 * One line a person can act on. Validation failures arrive as a JSON list of issues; the engine's
 * "thread not found" gets the command that lists threads.
 */
export function readableError(message: string): string {
  const text = message.trim();
  if (text.startsWith("[")) {
    try {
      const issues = JSON.parse(text) as unknown;
      if (Array.isArray(issues) && issues.length && issues.every((issue) => issue && typeof issue === "object" && typeof (issue as { message?: unknown }).message === "string")) {
        return (issues as { path?: unknown[]; message: string }[]).slice(0, 5).map((issue) => `${issue.path?.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`).join("; ");
      }
    } catch { /* not JSON: show as is */ }
  }
  return /^Console thread was not found\.?$/.test(text) ? "Thread not found. List threads with `0 threads list`." : message;
}
