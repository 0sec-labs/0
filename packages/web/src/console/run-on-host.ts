import { BackendDescriptorSchema, parseBackendHandshake } from "@0/engine/dist/shared/backend-protocol.js";
import { createBackendApi, localControlFetch } from "@/api";
import type { useBackendSelection } from "@/backend-context";

type BackendApi = ReturnType<typeof createBackendApi>;

/**
 * Run an action against another execution host. The current host reuses its scoped api; any other host is
 * handshaken fresh and its short-lived client is disposed afterwards.
 */
export async function runOnBackendHost<T>(input: {
  backendId: string;
  currentBackendId: string;
  currentApi: BackendApi;
  registry: ReturnType<typeof useBackendSelection>;
  action: (api: BackendApi) => Promise<T>;
}): Promise<T> {
  const { backendId, currentBackendId, currentApi, registry, action } = input;
  if (backendId === currentBackendId) return action(currentApi);
  let descriptor = registry?.backends.find((item) => item.id === backendId);
  if (backendId !== "local") {
    if (!descriptor) throw new Error("Host is no longer registered.");
    const response = await localControlFetch(`/api/backends/${encodeURIComponent(backendId)}/handshake`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Host connection returned ${response.status}.`);
    const value = (await response.json()) as { backend?: unknown; handshake?: unknown; error?: string };
    const owner = BackendDescriptorSchema.parse(value.backend);
    if (owner.id !== backendId || owner.status !== "connected" || !value.handshake)
      throw new Error(value.error || owner.error || "Host is disconnected.");
    const handshake = parseBackendHandshake(value.handshake);
    descriptor = {
      ...owner,
      protocolVersion: handshake.protocolVersion,
      capabilities: handshake.capabilities,
      platform: handshake.platform,
    };
  }
  const scoped = createBackendApi(backendId, descriptor);
  try {
    return await action(scoped);
  } finally {
    scoped.client.dispose();
  }
}
