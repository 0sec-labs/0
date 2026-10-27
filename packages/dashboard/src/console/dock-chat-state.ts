import type { DesktopConsoleSession } from "@0/shared";
import { chatResourceKey, parseChatResourceKey } from "./chat-host";

export interface DockChatReference {
  id: string;
  title: string;
  savedId?: string;
  backendId?: string;
}

export interface ReconciledDockChatState {
  chats: DockChatReference[];
  activeChatId: string | null;
  /** Old IDs to replacement live IDs or null for removed views; no `chat:` prefix. */
  chatIdRemap: Record<string, string | null>;
}

/** Reconcile saved tab references against the authoritative accessible live roster.
 * Call only after that roster finishes loading. This never resumes saved work.
 */
export function reconcileDockChatState({ chats, activeChatId, sessions, primarySessionId, defaultBackendId, sessionsByBackend, primaryBackendId }: {
  chats: unknown;
  activeChatId: unknown;
  sessions: readonly DesktopConsoleSession[];
  primarySessionId?: string;
  defaultBackendId?: string;
  primaryBackendId?: string;
  sessionsByBackend?: Readonly<Record<string, readonly DesktopConsoleSession[] | undefined>>;
}): ReconciledDockChatState {
  if (defaultBackendId) return reconcileHostDockChats({chats,activeChatId,sessions,primarySessionId,defaultBackendId,primaryBackendId,sessionsByBackend});
  const visible = sessions.filter(session => session.status !== "closed");
  const byId = new Map(visible.map(session => [session.id, session]));
  const allById = new Map(sessions.map(session => [session.id, session]));
  const bySavedId = new Map<string, DesktopConsoleSession>();
  const updated = (session: DesktopConsoleSession) => Date.parse(session.updatedAt) || Date.parse(session.createdAt) || 0;
  for (const session of visible) {
    if (!session.savedId) continue;
    const previous = bySavedId.get(session.savedId);
    if (!previous || updated(session) > updated(previous) || updated(session) === updated(previous) && session.id < previous.id) bySavedId.set(session.savedId, session);
  }
  const reconciled: DockChatReference[] = [];
  const seen = new Set<string>();
  const remap = new Map<string, string | null>();
  const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
  const references: DockChatReference[] = Array.isArray(chats) ? chats.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item=value as Record<string,unknown>;
    if (!validId(item.id)) return [];
    return [{id:item.id,title:typeof item.title === "string" ? item.title : "",...(validId(item.savedId) ? {savedId:item.savedId} : {})}];
  }) : [];
  for (const reference of references) {
    remap.set(reference.id,null);
    const durableId = reference.savedId || allById.get(reference.id)?.savedId || reference.id;
    const session = byId.get(reference.id) ?? bySavedId.get(durableId) ?? byId.get(durableId);
    if (!session || session.id === primarySessionId) continue;
    if (reference.id !== session.id) remap.set(reference.id, session.id);
    else remap.delete(reference.id);
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const title = (session.title?.trim() || session.target?.trim() || reference.title?.trim() || "New chat").replace(/[\u0000-\u001f\u007f]/g," ").slice(0, 200);
    const savedId = session.savedId || reference.savedId;
    reconciled.push({ id: session.id, title, ...(savedId ? { savedId } : {}) });
  }
  const active = validId(activeChatId) ? (remap.has(activeChatId) ? remap.get(activeChatId) : activeChatId) : null;
  return { chats: reconciled, activeChatId: active && seen.has(active) ? active : null, chatIdRemap: Object.fromEntries(remap) };
}

function reconcileHostDockChats({chats,activeChatId,sessions,primarySessionId,defaultBackendId,primaryBackendId,sessionsByBackend}: {
  chats:unknown; activeChatId:unknown; sessions:readonly DesktopConsoleSession[]; primarySessionId?:string; defaultBackendId:string; primaryBackendId?:string;
  sessionsByBackend?:Readonly<Record<string,readonly DesktopConsoleSession[]|undefined>>;
}):ReconciledDockChatState {
  const result:DockChatReference[]=[];
  const seen=new Set<string>();
  const remap:Record<string,string|null>={};
  for(const value of Array.isArray(chats)?chats:[]) {
    if(!value || typeof value!=="object" || typeof value.id!=="string") continue;
    if(value.backendId!==undefined && typeof value.backendId!=="string") continue;
    const ref=parseChatResourceKey(value.id,value.backendId ?? defaultBackendId);
    if(!ref || value.backendId && ref.backendId!==value.backendId) continue;
    const oldKey=chatResourceKey(ref);
    const roster=ref.backendId===defaultBackendId?sessions:sessionsByBackend?.[ref.backendId];
    // A different host being offline/unloaded is not evidence that its chat vanished.
    const normalized=roster===undefined ? {chats:[{id:ref.id,title:typeof value.title==="string"?value.title:"Chat",...(typeof value.savedId==="string"?{savedId:value.savedId}:{})}],activeChatId:null,chatIdRemap:{}} : reconcileDockChatState({chats:[{...value,id:ref.id}],activeChatId:null,sessions:roster,primarySessionId:ref.backendId===(primaryBackendId ?? defaultBackendId)?primarySessionId:undefined});
    const item=normalized.chats[0];
    const nextKey=item?chatResourceKey({backendId:ref.backendId,id:item.id}):null;
    if(nextKey!==oldKey) remap[oldKey]=nextKey;
    if(ref.backendId===defaultBackendId && !value.id.includes("~")) remap[value.id]=nextKey;
    if(!item || !nextKey || seen.has(nextKey)) continue;
    seen.add(nextKey);
    result.push({...item,backendId:ref.backendId,title:(item.title||"Chat").replace(/[\u0000-\u001f\u007f]/g," ").slice(0,200)});
  }
  const activeRef=typeof activeChatId==="string"?parseChatResourceKey(activeChatId,defaultBackendId):undefined;
  const activeKey=activeRef?chatResourceKey(activeRef):null;
  const mapped=activeKey && Object.hasOwn(remap,activeKey)?remap[activeKey]:activeKey;
  return {chats:result,activeChatId:mapped && seen.has(mapped)?mapped:null,chatIdRemap:remap};
}

/** Embedded chats must not reconcile or persist the root workspace's panel roster. */
export function dockWorkspaceStorageKey({ backendId, embeddedSessionId, workspaceId, userId }: { backendId: string; embeddedSessionId?: string; workspaceId?: string; userId?: string }): string {
  return embeddedSessionId ? `0-console-embedded-dock:${backendId}:${embeddedSessionId}` : `0-console-workspace-dock:${workspaceId ?? "solo"}:${userId ?? "local"}`;
}
