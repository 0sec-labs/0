import type { ConsoleCreateSessionInput, ConsoleRuntimeSelection, ConsoleRuntimeSnapshot, DesktopConsoleSession } from "@0/shared";
import {localControlFetch,type BackendApi} from "@/api";

/** Model ownership is separate from the engine that executes the chat's tools. */
export function usesLocalModels(runtime:ConsoleRuntimeSnapshot|null|undefined):boolean {
  return (runtime as (ConsoleRuntimeSnapshot & {modelSource?:"local"|"host"})|null|undefined)?.modelSource === "local";
}
export function modelCatalogOwner(backendId:string,runtime:ConsoleRuntimeSnapshot|null|undefined):string {
  return usesLocalModels(runtime)?"local":backendId;
}
async function localSession(path:string,body:unknown,method:"POST"|"PATCH"):Promise<DesktopConsoleSession> {
  const response=await localControlFetch(path,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const value=await response.json() as {session?:DesktopConsoleSession;error?:string};
  if(!response.ok || !value.session || typeof value.session.id!=="string")throw new Error(value.error || `Chat configuration returned ${response.status}.`);
  return value.session;
}
/** Local control creates the server-only relay grant; no credential or grant crosses this UI. */
export function createChatOnExecutionHost(backendId:string,configuration:ConsoleCreateSessionInput):Promise<DesktopConsoleSession> {
  return backendId === "local" ? localSession("/api/console/sessions",configuration,"POST") : localSession("/api/console/remote-sessions",{backendId,configuration},"POST");
}
export function configureChatRuntime(api:BackendApi,id:string,runtime:ConsoleRuntimeSelection,source:ConsoleRuntimeSnapshot|null|undefined):Promise<DesktopConsoleSession> {
  return api.client.backendId!=="local" && usesLocalModels(source)
    ? localSession(`/api/console/remote-sessions/${encodeURIComponent(id)}/configuration`,{backendId:api.client.backendId,runtime},"PATCH")
    : api.configureConsoleSession(id,{runtime}).then(result=>result.session);
}

/** Verify the live relay, rather than inferring health from configured credentials. */
export async function localModelSourceHealthy(backendId: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  const response = await localControlFetch(`/api/console/remote-sessions/${encodeURIComponent(sessionId)}/status?backendId=${encodeURIComponent(backendId)}`, { signal });
  if (!response.ok) return false;
  const value = await response.json() as { local?: { phase?: string; lastPollAt?: string | null }; remote?: { available?: boolean } };
  const lastPoll = Date.parse(value.local?.lastPollAt ?? "");
  return value.remote?.available === true && ["polling", "requesting", "streaming"].includes(value.local?.phase ?? "") && Number.isFinite(lastPoll) && Date.now() - lastPoll < 60_000;
}
