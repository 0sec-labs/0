import { useMemo } from "react";
import { describeApiFailure } from "@/lib/api-error";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import {
  SENTINEL_RUN_APPROVAL, SENTINEL_TRIGGER_APPROVAL, SentinelApiError,
  type Sentinel, type SentinelActivation, type SentinelAutomation, type SentinelFile, type SentinelFileEntry, type SentinelFileRevision, type SentinelBudgetReport, type SentinelPreset, type SentinelPresetAutomation, type SentinelSchedule, type SentinelTrigger, type SentinelTriggerKind,
} from "./model";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;
const BASE = "/api/console/";

/** Thin JSON client over the backend transport. Errors keep their HTTP status so the UI can tell a conflict from a failure. */
export function createSentinelClient(webFetch: Fetch) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await webFetch(BASE + path, init);
    const json = (response.headers.get("content-type") ?? "").includes("json");
    if (!response.ok) {
      let data: { error?: string; code?: string } = {};
      if (json) { try { data = await response.json() as typeof data; } catch { /* keep status text */ } }
      throw new SentinelApiError(describeApiFailure({ status: response.status, code: data.code, error: data.error, statusText: response.statusText }), response.status);
    }
    if (!json) throw new SentinelApiError("The engine returned a non-JSON response.", 502);
    return await response.json() as T;
  }
  const body = (method: string, value: unknown): RequestInit => ({ method, body: JSON.stringify(value) });
  const id = encodeURIComponent;
  const filePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  return {
    /** `supported: false` means the server predates Sentinels (404/405 or a non-JSON fallback page). */
    async list(signal?: AbortSignal): Promise<{ supported: boolean; sentinels: Sentinel[] }> {
      try {
        const data = await call<{ sentinels: Sentinel[] }>("sentinels", { signal });
        return Array.isArray(data.sentinels) ? { supported: true, sentinels: data.sentinels } : { supported: false, sentinels: [] };
      } catch (error) {
        if (error instanceof SentinelApiError && [404, 405, 501, 502].includes(error.status)) return { supported: false, sentinels: [] };
        throw error;
      }
    },
    presets: (signal?: AbortSignal) => call<{ presets: SentinelPreset[] }>("sentinel-presets", { signal }).then(data => data.presets),
    get: (sentinelId: string, signal?: AbortSignal) => call<{ sentinel: Sentinel }>(`sentinels/${id(sentinelId)}`, { signal }).then(data => data.sentinel),
    create: (input: Record<string, unknown>) => call<{ sentinel: Sentinel; suggestedAutomations?: SentinelPresetAutomation[] }>("sentinels", body("POST", input)),
    update: (sentinelId: string, version: number, fields: Record<string, unknown>) => call<{ sentinel: Sentinel }>(`sentinels/${id(sentinelId)}`, body("PATCH", { version, ...fields })).then(data => data.sentinel),
    remove: (sentinelId: string, version: number) => call<{ ok: true }>(`sentinels/${id(sentinelId)}?version=${version}`, { method: "DELETE" }),
    setPaused: (sentinelId: string, paused: boolean, version: number) => call<{ sentinel: Sentinel }>(`sentinels/${id(sentinelId)}/${paused ? "pause" : "resume"}`, body("POST", { version })).then(data => data.sentinel),
    run: (sentinelId: string, version: number, task?: string) => call<{ activation: SentinelActivation; sentinel: Sentinel }>(`sentinels/${id(sentinelId)}/run`, body("POST", { approval: SENTINEL_RUN_APPROVAL, version, ...(task?.trim() ? { task: task.trim() } : {}) })),
    activations: (sentinelId: string, signal?: AbortSignal) => call<{ activations: SentinelActivation[] }>(`sentinels/${id(sentinelId)}/activations?limit=50`, { signal }).then(data => data.activations),
    acknowledge: (sentinelId: string, version: number) => call<{ sentinel: Sentinel }>(`sentinels/${id(sentinelId)}/acknowledge`, body("POST", { version })).then(data => data.sentinel),
    budget: (sentinelId: string, signal?: AbortSignal) => call<SentinelBudgetReport>(`sentinels/${id(sentinelId)}/budget`, { signal }),
    triggers: (sentinelId: string, signal?: AbortSignal) => call<{ triggers: SentinelTrigger[] }>(`sentinels/${id(sentinelId)}/triggers`, { signal }),
    /** Creating enabled needs the review approval; the default is disabled. */
    createTrigger: (sentinelId: string, input: { automationId: string; kind: SentinelTriggerKind; schedule?: SentinelSchedule; github?: { repo: string; baseBranch?: string; pollMs?: number }; enabled?: boolean }) =>
      call<{ trigger: SentinelTrigger }>(`sentinels/${id(sentinelId)}/triggers`, body("POST", { ...input, ...(input.enabled ? { approval: SENTINEL_TRIGGER_APPROVAL } : {}) })).then(data => data.trigger),
    /** Enabling sends the approval token; the UI must have shown the review dialog first. */
    updateTrigger: (sentinelId: string, triggerId: string, version: number, patch: { enabled?: boolean; schedule?: SentinelSchedule; github?: { repo: string; baseBranch?: string; pollMs?: number } }) =>
      call<{ trigger: SentinelTrigger }>(`sentinels/${id(sentinelId)}/triggers/${id(triggerId)}`, body("PATCH", { expectedVersion: version, ...patch, ...(patch.enabled ? { approval: SENTINEL_TRIGGER_APPROVAL } : {}) })).then(data => data.trigger),
    removeTrigger: (sentinelId: string, triggerId: string) => call<{ ok: true }>(`sentinels/${id(sentinelId)}/triggers/${id(triggerId)}`, { method: "DELETE" }),
    automations: (sentinelId: string, signal?: AbortSignal) => call<{ automations: SentinelAutomation[] }>(`sentinels/${id(sentinelId)}/automations`, { signal }).then(data => data.automations),
    files: (sentinelId: string, signal?: AbortSignal) => call<{ files: SentinelFileEntry[]; folders: string[] }>(`sentinels/${id(sentinelId)}/files`, { signal }),
    file: (sentinelId: string, path: string, signal?: AbortSignal) => call<{ file: SentinelFile; revisions?: SentinelFileRevision[] }>(`sentinels/${id(sentinelId)}/files/${filePath(path)}?revisions=1`, { signal }),
    saveFile: (sentinelId: string, path: string, content: string, revision: number | null) => call<{ file: SentinelFile }>(`sentinels/${id(sentinelId)}/files/${filePath(path)}`, body("PUT", { content, revision })).then(data => data.file),
  };
}
export type SentinelClient = ReturnType<typeof createSentinelClient>;

export function useSentinelClient(): { client: SentinelClient; scope: readonly [string, string] } {
  const api = useBackendApi();
  return useMemo(() => ({ client: createSentinelClient(api.webFetch), scope: ["sentinels", api.client.backendId] as const }), [api.webFetch, api.client.backendId]);
}

const invalidateAll = (cache: QueryClient, scope: readonly string[]) => cache.invalidateQueries({ queryKey: scope });

/** List of Sentinels. `supported` is false on old servers, so callers can hide the whole feature. */
export function useSentinels(options: { enabled?: boolean; poll?: boolean } = {}) {
  const { client, scope } = useSentinelClient();
  const query = useQuery({ queryKey: [...scope, "list"], queryFn: ({ signal }) => client.list(signal), enabled: options.enabled ?? true, staleTime: 5_000, refetchInterval: options.poll === false ? false : 10_000, retry: false });
  return { ...query, supported: query.data?.supported !== false, sentinels: query.data?.sentinels ?? [] };
}
export function useSentinel(sentinelId: string) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "one", sentinelId], queryFn: ({ signal }) => client.get(sentinelId, signal), enabled: Boolean(sentinelId), refetchInterval: 10_000, retry: false });
}
export function useSentinelPresets(enabled = true) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "presets"], queryFn: ({ signal }) => client.presets(signal), enabled, staleTime: 5 * 60_000, retry: false });
}
export function useSentinelActivations(sentinelId: string) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "activations", sentinelId], queryFn: ({ signal }) => client.activations(sentinelId, signal), refetchInterval: 5_000, retry: false });
}
export function useSentinelAutomations(sentinelId: string) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "automations", sentinelId], queryFn: ({ signal }) => client.automations(sentinelId, signal), retry: false });
}
export function useSentinelBudget(sentinelId: string) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "budget", sentinelId], queryFn: ({ signal }) => client.budget(sentinelId, signal), refetchInterval: 30_000, retry: false });
}
export function useSentinelTriggers(sentinelId: string) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "triggers", sentinelId], queryFn: ({ signal }) => client.triggers(sentinelId, signal), retry: false });
}
export function useSentinelFiles(sentinelId: string) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "files", sentinelId], queryFn: ({ signal }) => client.files(sentinelId, signal), retry: false });
}
export function useSentinelFile(sentinelId: string, path: string | null) {
  const { client, scope } = useSentinelClient();
  return useQuery({ queryKey: [...scope, "file", sentinelId, path], queryFn: ({ signal }) => client.file(sentinelId, path!, signal), enabled: path !== null, retry: false, staleTime: 0, gcTime: 0 });
}

export function useSentinelMutations() {
  const { client, scope } = useSentinelClient();
  const cache = useQueryClient();
  const refresh = () => invalidateAll(cache, scope);
  return {
    create: useMutation({ mutationFn: (input: Record<string, unknown>) => client.create(input), onSuccess: refresh }),
    update: useMutation({ mutationFn: (input: { id: string; version: number; fields: Record<string, unknown> }) => client.update(input.id, input.version, input.fields), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (input: { id: string; version: number }) => client.remove(input.id, input.version), onSuccess: refresh }),
    setPaused: useMutation({ mutationFn: (input: { id: string; paused: boolean; version: number }) => client.setPaused(input.id, input.paused, input.version), onSuccess: refresh }),
    run: useMutation({ mutationFn: (input: { id: string; version: number; task?: string }) => client.run(input.id, input.version, input.task), onSuccess: refresh }),
    acknowledge: useMutation({ mutationFn: (input: { id: string; version: number }) => client.acknowledge(input.id, input.version), onSuccess: refresh }),
    createTrigger: useMutation({ mutationFn: (input: { id: string; automationId: string; kind: SentinelTriggerKind; schedule?: SentinelSchedule; github?: { repo: string; baseBranch?: string } }) => client.createTrigger(input.id, { automationId: input.automationId, kind: input.kind, ...(input.schedule ? { schedule: input.schedule } : {}), ...(input.github ? { github: input.github } : {}) }), onSuccess: refresh }),
    updateTrigger: useMutation({ mutationFn: (input: { id: string; triggerId: string; version: number; enabled: boolean }) => client.updateTrigger(input.id, input.triggerId, input.version, { enabled: input.enabled }), onSuccess: refresh }),
    removeTrigger: useMutation({ mutationFn: (input: { id: string; triggerId: string }) => client.removeTrigger(input.id, input.triggerId), onSuccess: refresh }),
    saveFile: useMutation({ mutationFn: (input: { id: string; path: string; content: string; revision: number | null }) => client.saveFile(input.id, input.path, input.content, input.revision), onSuccess: (_file, input) => { void cache.invalidateQueries({ queryKey: [...scope, "files", input.id] }); } }),
  };
}
