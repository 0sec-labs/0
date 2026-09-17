import { loadCloudCredentials, CloudClient, CloudError, CloudUnauthorizedError, CloudForbiddenError } from "@0sec/core";
import type { HostedVerificationStatus } from "./connect-layout.js";
import { hostedBrowserLoginFlow, type HostedBrowserLoginOptions, type HostedLoginPhase, type LoginResult } from "../commands/auth.js";

export interface HostedDeviceAuthUpdate {
  phase: HostedLoginPhase | "failed";
  message: string;
  loginUrl?: string;
}

export interface StartHostedDeviceAuthOptions extends Omit<HostedBrowserLoginOptions, "signal" | "onStatus"> {
  onUpdate: (update: HostedDeviceAuthUpdate) => void;
  /** Login persisted; this does not establish funds or service availability. */
  onConnected: () => void;
  onSettled?: (result: LoginResult) => void;
}

/** Return safe local metadata only. Presence is not authentication or funding proof. */
export function readHostedConnection(env: Record<string, string | undefined>, homeDir?: string): { configured: boolean; host?: string; warning?: string } {
  let warning: string | undefined;
  try {
    const credentials = loadCloudCredentials({ env, homeDir, warn: (message) => { warning = message; } });
    return { configured: true, host: credentials.host, warning };
  } catch {
    return { configured: false };
  }
}

/** The canonical helper owns polling and credential writes. This bridge owns UI cancellation. */
export function startHostedDeviceAuth(options: StartHostedDeviceAuthOptions): { cancel(): void } {
  const controller = new AbortController();
  const { onUpdate, onConnected, onSettled, ...loginOptions } = options;
  let phase: HostedDeviceAuthUpdate["phase"] = "opening";
  void hostedBrowserLoginFlow({
    ...loginOptions,
    signal: controller.signal,
    onStatus: (next, message, loginUrl) => {
      if (controller.signal.aborted) return;
      phase = next;
      onUpdate({ phase: next, message, loginUrl });
    },
  }).then((result) => {
    if (controller.signal.aborted) return;
    if (result.ok) onConnected();
    else if (phase !== "timeout") onUpdate({ phase: "failed", message: result.error });
    onSettled?.(result);
  }, () => {
    if (!controller.signal.aborted) onUpdate({ phase: "failed", message: "0cloud sign-in could not complete. Use your own provider or try again." });
  });
  return { cancel: () => controller.abort() };
}

/**
 * Verify a saved 0sec Cloud sign-in against the backend by calling the
 * Bearer-authenticated account endpoint (`GET /api/inference/account`). This is
 * the real check the connect screen shows instead of trusting that the browser
 * flow merely completed: a good token returns the account (and its credit
 * balance); a refused token (401/403) proves the sign-in is stale; any other
 * failure is a transient network problem, not a bad token. Never throws.
 */
export async function verifyHostedConnection(opts: {
  env: Record<string, string | undefined>;
  homeDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<HostedVerificationStatus> {
  const creds = loadCloudCredentials({ env: opts.env, homeDir: opts.homeDir, warn: () => {} });
  if (!creds.token || !creds.host) return { kind: "unreachable" };
  const client = new CloudClient({ host: creds.host, token: creds.token, fetchImpl: opts.fetchImpl });
  try {
    const account = await client.getInferenceAccount();
    return { kind: "verified", remainingUsd: typeof account.remainingUsd === "number" ? account.remainingUsd : undefined };
  } catch (error) {
    if (error instanceof CloudUnauthorizedError || error instanceof CloudForbiddenError) return { kind: "rejected" };
    if (error instanceof CloudError) {
      // The gateway distinguishes a deliberate service gate from an outage via a
      // body code; surface that instead of a blanket "unreachable".
      if (error.code === "inference_disabled") return { kind: "disabled" };
      if (error.status === 402 || error.code === "insufficient_funds") return { kind: "no-credits" };
      // provider_unavailable / billing_unavailable / other 5xx are genuine outages.
    }
    return { kind: "unreachable" };
  }
}
