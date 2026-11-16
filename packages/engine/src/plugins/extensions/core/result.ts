/** Typed results for the extension seams. Core code returns these instead of throwing. */
export type ExtensionErrorCode =
  | "bad_source" | "invalid_manifest" | "legacy_executable" | "unsafe_content" | "content_mismatch" | "sha_not_found" | "fetch_failed"
  | "reserved_name" | "name_taken" | "name_changed" | "not_installed" | "review_mismatch" | "needs_approval" | "needs_confirmation"
  | "builtin" | "tampered" | "missing" | "legacy" | "state_corrupt" | "io";

export interface ExtensionError { readonly code: ExtensionErrorCode; readonly message: string }
export type Result<T, E = ExtensionError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = (code: ExtensionErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

/** Unwrap for adapters that prefer exceptions at their outer edge (the CLI). */
export class ExtensionFailure extends Error {
  constructor(readonly error: ExtensionError) { super(error.message); this.name = "ExtensionFailure"; }
}
export const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new ExtensionFailure(result.error); return result.value; };
