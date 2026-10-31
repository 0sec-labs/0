import { isCancelledError } from "@tanstack/react-query";

/** Navigation and query replacement cancel work without failing the user action. */
export function isRequestCancellation(error: unknown): boolean {
  return isCancelledError(error) || error instanceof Error && error.name === "AbortError";
}
