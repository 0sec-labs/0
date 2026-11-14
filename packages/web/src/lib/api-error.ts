/**
 * One place that turns backend refusals into plain, actionable sentences. The backend answers
 * `{ error, code }`; the codes below are part of the contract (privileged routes, approvals, model enablement).
 */
export const API_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  browser_only: "This change can only be made from the browser console, not from a connected tool.",
  owner_required: "Only workspace owners can do this. Ask an owner to make the change.",
  approval_required: "Review and approve this change first, then try again.",
  model_disabled: "That model is turned off for this connection. Turn it on in Connections to use it.",
});

/** Error that keeps the HTTP status and backend code next to a message that is already safe to show. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "ApiError"; }
}

/** Friendly text for a known code, else the backend's own sentence, else a status-based fallback (never a bare "Request failed"). */
export function describeApiFailure(input: { status: number; code?: string | null; error?: string | null; statusText?: string }): string {
  const known = input.code ? API_ERROR_MESSAGES[input.code] : undefined;
  if (known) return known;
  if (input.error?.trim()) return input.error;
  return `${input.status} ${input.statusText ?? ""}`.trim();
}

/** Build the thrown error from a failed response body (already parsed, may be null). */
export function apiErrorFrom(response: { status: number; statusText: string }, body: unknown): ApiError {
  const data = body && typeof body === "object" ? body as { error?: unknown; code?: unknown } : {};
  const code = typeof data.code === "string" ? data.code : undefined;
  const error = typeof data.error === "string" ? data.error : undefined;
  return new ApiError(describeApiFailure({ status: response.status, code, error, statusText: response.statusText }), response.status, code);
}

export const apiErrorCode = (error: unknown): string | undefined => error instanceof ApiError ? error.code : undefined;
export const isModelDisabledError = (error: unknown): boolean =>
  apiErrorCode(error) === "model_disabled" || (error instanceof Error && isModelDisabledText(error.message));
/** Text-only detection for errors that reach the UI as strings (session error events). */
export const isModelDisabledText = (message: string): boolean => /\bmodel_disabled\b|turned off for this connection/i.test(message);

/** Map free text that embeds a raw backend code to the friendly sentence. Unknown text passes through untouched. */
export function mapErrorText(message: string): string {
  if (isModelDisabledText(message)) return API_ERROR_MESSAGES.model_disabled!;
  for (const code of ["browser_only", "owner_required", "approval_required"]) if (new RegExp(`\\b${code}\\b`).test(message)) return API_ERROR_MESSAGES[code]!;
  return message;
}

export const CONNECTIONS_HREF = "/connections";
