import { chatDropPosition } from "./dock-drop-position";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IDockviewPanelHeaderProps, type IDockviewHeaderActionsProps } from "dockview-react";
import { createDockLifecycle } from "./dock-lifecycle";
import { parseDockChatDrag } from "./dock-chat-drag";
import { chatResourceKey, parseChatResourceKey } from "./chat-host";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { usePersistentState } from "@/lib/use-persistent-state";
import { restoreDockLayout, type SavedDockLayout } from "./dock-layout";
import "dockview-react/dist/styles/dockview.css";
import "./dock-workspace.css";

export type DockPanelId = "agents" | "details" | "browser";
type SlotId = DockPanelId | "chat";
export const CHAT_DRAG_MIME = "application/x-0-console-chat";
export interface DockChat { id: string; backendId?: string; title: string; content: ReactNode; actions?: ReactNode }
const dockChatKey = (chat:DockChat,backendId:string) => chatResourceKey({backendId:chat.backendId ?? backendId,id:chat.id});
const chatPanelId = (id: string) => `chat:${id}`;
const titles: Record<SlotId, string> = { chat: "Chat", agents: "Agents", details: "Details", browser: "Browser" };
const Slots = createContext<Record<string, ReactNode>>({ chat: null, agents: null, details: null, browser: null });
function Slot({ api }: IDockviewPanelProps) {
  const slots = useContext(Slots);
  return <div data-dock-panel-id={api.id} className={`console-dock-slot console-dock-${api.id}`}>{slots[api.id as SlotId]}</div>;
}
function HeaderActions({ activePanel }: IDockviewHeaderActionsProps) {
  const slots = useContext(Slots);
  return activePanel ? <div className="console-dock-actions">{slots[`actions:${activePanel.id}`]}</div> : null;
}
const ClosePanel=createContext<((api:IDockviewPanelHeaderProps["api"])=>void)|undefined>(undefined);
const ClosePrimary = createContext<(() => void) | undefined>(undefined);
function Tab({ api, params }: IDockviewPanelHeaderProps) {
  const slots = useContext(Slots);
  const closePrimary = useContext(ClosePrimary);
  const closePanel=useContext(ClosePanel);
  const [title,setTitle] = useState(api.title);
  useEffect(()=>{const listener=api.onDidTitleChange(event=>setTitle(event.title));return()=>listener.dispose();},[api]);
  const label=title || titles[api.id as SlotId];
  const closable=api.id !== "chat" || params?.closable === true;
  const owner=typeof params?.backendId === "string" ? params.backendId : undefined;
  const emptyPlaceholder = api.id === "chat" && !closable && Object.keys(slots).some(key => key.startsWith("chat:"));
  return <div className="console-dock-tab" data-empty-placeholder={emptyPlaceholder || undefined}>
    <Tooltip content={owner ? <><span>{label}</span><span className="block text-muted-foreground">Host: {owner}</span></> : label}><span>{label}</span></Tooltip>
    {closable && <Tooltip content={owner ? `Close view on ${owner}` : "Close view"}><Button variant="ghost" size="icon-xs" type="button" aria-label={`Close ${label}`} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if(api.id === "chat") closePrimary?.(); else closePanel?.(api); }}><X size={13} /></Button></Tooltip>}
  </div>;
}
// Stable component identities are essential: streaming updates must not recreate panels.
const components = { slot: Slot };
const tabComponents = { tab: Tab };
const isAux = (id?: string): id is DockPanelId => id === "agents" || id === "details" || id === "browser";

/** Animate structural changes only; sash resizing stays synchronous and unanimated. */
function installDockMotion(dock: DockviewApi, host: HTMLElement) {
  let before: Map<string, { rect: DOMRect; element: HTMLElement }> | undefined;
  let frame = 0;
  const animations = new Set<Animation>();
  const ghosts = new Set<HTMLElement>();
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.reducedMotion === "true" || Boolean(host.closest('[data-reduced-motion="true"]'));
  const clear = () => { for (const animation of animations) animation.cancel(); animations.clear(); for (const ghost of ghosts) ghost.remove(); ghosts.clear(); };
  const animate = (element:HTMLElement, keyframes:Keyframe[], finish?:()=>void) => {
    const animation = element.animate(keyframes,{ duration:190,easing:"cubic-bezier(.22,1,.36,1)" });
    animations.add(animation);
    const done = () => { animations.delete(animation); finish?.(); };
    animation.onfinish=done; animation.oncancel=done;
  };
  const surfaces = () => {
    const groups=dock.groups.map(group=>({id:`group:${group.id}`,element:group.element,rect:group.element.getBoundingClientRect()}));
    // renderer="always" content lives in Dockview overlays outside the group DOM.
    const overlays=Array.from(host.querySelectorAll<HTMLElement>("[data-dock-panel-id]")).flatMap(slot=>{
      const id=slot.dataset.dockPanelId!;
      const panel=dock.getPanel(id);
      const element=slot.closest<HTMLElement>(".dv-render-overlay");
      return panel?.api.isVisible && element && !groups.some(group=>group.element.contains(element)) ? [{id:`panel:${id}`,element,rect:element.getBoundingClientRect()}] : [];
    });
    return [...groups,...overlays];
  };
  const will = dock.onWillMutateLayout(event => {
    if (!["add","remove","move","maximize","tab-group"].includes(event.kind) || reduced() || before) return;
    clear();
    before = new Map(surfaces().map(surface=>[surface.id,surface]));
  });
  const did = dock.onDidMutateLayout(() => {
    if (!before || frame) return;
    frame=requestAnimationFrame(()=>{
      frame=0; const previous=before; before=undefined;
      if (!previous || reduced() || !host.isConnected) return;
      const groups=surfaces();
      const currentIds=new Set(groups.map(group=>group.id));
      const hostRect=host.getBoundingClientRect();
      for(const [id,old] of previous) {
        if(!id.startsWith("group:") || currentIds.has(id) || old.rect.width<1 || old.rect.height<1) continue;
        // A lightweight surface fades out; no duplicate transcript, controls or remote media.
        const ghost=document.createElement("div");
        ghost.className="console-dock-closing-surface"; ghost.setAttribute("aria-hidden","true"); ghost.inert=true;
        Object.assign(ghost.style,{left:`${old.rect.left-hostRect.left}px`,top:`${old.rect.top-hostRect.top}px`,width:`${old.rect.width}px`,height:`${old.rect.height}px`});
        host.append(ghost); ghosts.add(ghost);
        animate(ghost,[{opacity:.7,transform:"scale(1)"},{opacity:0,transform:"scale(.975)"}],()=>{ghost.remove();ghosts.delete(ghost);});
      }
      for(const group of groups) {
        if(group.rect.width<1 || group.rect.height<1) continue;
        const old=previous.get(group.id);
        if(!old) { animate(group.element,[{opacity:0,transform:"translateX(12px) scale(.985)"},{opacity:1,transform:"none"}]); continue; }
        const dx=old.rect.left-group.rect.left,dy=old.rect.top-group.rect.top;
        const sx=old.rect.width/group.rect.width,sy=old.rect.height/group.rect.height;
        if(Math.abs(dx)<.5 && Math.abs(dy)<.5 && Math.abs(sx-1)<.005 && Math.abs(sy-1)<.005) continue;
        animate(group.element,[{transformOrigin:"top left",transform:`translate(${dx}px,${dy}px) scale(${sx},${sy})`},{transformOrigin:"top left",transform:"none"}]);
      }
    });
  });
  // Grabbing a sash cancels the previous structural animation immediately.
  const pointerDown = (event:PointerEvent) => { if(event.target instanceof Element && event.target.closest(".dv-sash")) clear(); };
  host.addEventListener("pointerdown",pointerDown,true);
  return { dispose:()=>{will.dispose();did.dispose();if(frame)cancelAnimationFrame(frame);clear();host.removeEventListener("pointerdown",pointerDown,true);} };
}

/** Dockview owns pane geometry; React owns all content and conversation state. */
export function DockWorkspace({ chat, actions, panels, activePanel, onActivePanelChange, extraChats = [], activeChatId = null, onActiveChatChange, onCloseChat, onOpenChat, primaryBackendId = "local", primarySessionId, primaryTitle = "New chat", primaryClosable = false, onClosePrimary, persistenceKey = "0-console-dock-layout", legacyPersistenceKey, restoreReady = true, chatIdRemap = {}, onRestoreLayoutState }: {
  onRestoreLayoutState?: (state: { openPanels: DockPanelId[]; activePanel: DockPanelId | null; activeChatId: string | null }) => void;
  persistenceKey?: string;
  legacyPersistenceKey?: string;
  restoreReady?: boolean;
  chatIdRemap?: Record<string, string | null>;
  chat: ReactNode;
  primaryBackendId?:string;
  primarySessionId?:string;
  actions?: ReactNode;
  primaryTitle?: string;
  primaryClosable?: boolean;
  onClosePrimary?: (replacement?: { id: string; backendId: string }) => void;
  extraChats?: DockChat[];
  activeChatId?: string | null;
  onActiveChatChange?: (id: string | null) => void;
  onCloseChat?: (id: string) => void;
  onOpenChat?: (id: string, title: string, saved?:boolean, backendId?:string, onResolved?:(ref:{id:string;backendId:string})=>void) => void;
  panels: Record<DockPanelId, ReactNode>;
  activePanel: DockPanelId | null;
  onActivePanelChange: (panel: DockPanelId | null) => void;
}) {
  const [storedLayout, setStoredLayout] = usePersistentState<SavedDockLayout | null>(`${persistenceKey}:layout`, null, { legacyKey: legacyPersistenceKey ? `${legacyPersistenceKey}:layout` : undefined });
  const persistence = useRef({ storedLayout, setStoredLayout, persistenceKey, restoreReady, extraChats, chatIdRemap, activeChatId, activePanel, onRestoreLayoutState });
  persistence.current = { storedLayout, setStoredLayout, persistenceKey, restoreReady, extraChats, chatIdRemap, activeChatId, activePanel, onRestoreLayoutState };
  const lastSerialized = useRef<{ key: string; layout: SavedDockLayout } | undefined>(undefined);
  const restoredKey = useRef<string | undefined>(undefined);
  const restoredDock = useRef<DockviewApi | undefined>(undefined);
  const currentDock = useRef<DockviewApi | undefined>(undefined);
  const lifecycle=useRef(createDockLifecycle<DockviewApi>());
  const mounted=useRef(true);
  const skipAuxReconcile = useRef(false);
  const skipChatReconcile = useRef(false);
  const selectedChat = useRef(activeChatId);
  const selectedAux = useRef(activePanel);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSave = useRef<(() => void) | undefined>(undefined);
  const captureLayout=useRef<(()=>void)|undefined>(undefined);
  const [api, setApi] = useState<DockviewApi>();
  const host = useRef<HTMLDivElement>(null);
  const dropPreview = useRef<HTMLDivElement>(null);
  const clearingDrag = useRef(false);
  const latest = useRef({ activePanel, onActivePanelChange, onActiveChatChange, onCloseChat, onOpenChat, primaryTitle, primaryClosable, onClosePrimary, primaryBackendId, primarySessionId });
  latest.current = { activePanel, onActivePanelChange, onActiveChatChange, onCloseChat, onOpenChat, primaryTitle, primaryClosable, onClosePrimary, primaryBackendId, primarySessionId };
  const pendingDrop = useRef<{id:string;group?:string;position:string} | undefined>(undefined);
  const syncing = useRef(false);
  const disposables = useRef<Array<{ dispose(): void }>>([]);
  useLayoutEffect(()=>{
    mounted.current=true;
    if(currentDock.current)lifecycle.current.activate(currentDock.current);
    return ()=>{
      // Layout cleanup precedes Dockview's passive destroy, including error-boundary removal.
      mounted.current=false;lifecycle.current.deactivate();
      if(saveTimer.current)clearTimeout(saveTimer.current);
      const save=pendingSave.current;pendingSave.current=undefined;save?.();
      // StrictMode can re-acquire the kept instance before this microtask runs.
      queueMicrotask(()=>{if(mounted.current)return;for(const item of disposables.current)item.dispose();disposables.current=[];currentDock.current=undefined;});
    };
  },[]);
  const restore = useCallback((dock: DockviewApi) => {
    const state = persistence.current;
    if (!mounted.current || !lifecycle.current.accepts(dock,Boolean(host.current?.isConnected)) || !state.restoreReady || (restoredKey.current === state.persistenceKey && restoredDock.current === dock)) return false;
    syncing.current = true;
    try {
      let layout = restoreDockLayout(lastSerialized.current?.key === state.persistenceKey ? lastSerialized.current.layout : state.storedLayout, state.extraChats.map(chat => dockChatKey(chat,latest.current.primaryBackendId)), state.chatIdRemap);
      if (layout) {
        try { dock.fromJSON(layout, { reuseExistingPanels: true }); } catch {
          // Dockview may clear its old grid before a bad renderer state throws.
          // Keep parent pane flags so normal reconciliation can reconstruct them.
          layout = undefined;
          if (!dock.getPanel("chat")) dock.addPanel({ id: "chat", title: latest.current.primaryTitle, params: { closable: latest.current.primaryClosable,backendId:latest.current.primaryBackendId }, component: "slot", tabComponent: "tab", renderer: "always", minimumWidth: 240 });
        }
      }
      restoredKey.current = state.persistenceKey; restoredDock.current = dock;
      selectedChat.current = state.activeChatId; selectedAux.current = state.activePanel;
      if (layout) {
        skipAuxReconcile.current = true; skipChatReconcile.current = true;
        const active = dock.activePanel?.id;
        const openPanels = dock.panels.flatMap(panel => isAux(panel.id) ? [panel.id] : []);
        const restoredChatId = active?.startsWith("chat:") ? active.slice(5) : null;
        // Parent restores its logical auxiliary selection independently of open views.
        // Establish that baseline without focusing it over the serialized active pane.
        selectedChat.current = restoredChatId;
        selectedAux.current = restoredChatId ? null : isAux(active) ? active : openPanels[0] ?? null;
        state.onRestoreLayoutState?.({ openPanels, activePanel: isAux(active) ? active : null, activeChatId: restoredChatId });
      }
      return Boolean(layout);
    } finally { syncing.current = false; }
  }, []);
  const hideDropPreview = () => { if (dropPreview.current) dropPreview.current.style.display = "none"; };
  const clearNativeDragOverlays = () => {
    if (clearingDrag.current || !host.current) return;
    clearingDrag.current = true;
    try {
      // Capture-owned sidebar drops bypass Dockview's bubbling drop cleanup.
      // Send its standard end signal so it releases both overlay DOM and state.
      for (const element of host.current.querySelectorAll(".dv-content-container, .dv-tabs-container")) element.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    } finally { clearingDrag.current = false; }
  };
  useEffect(() => {
    const finish = () => { hideDropPreview(); clearNativeDragOverlays(); };
    finish();
    window.addEventListener("dragend", finish);
    window.addEventListener("blur", finish);
    return () => { window.removeEventListener("dragend", finish); window.removeEventListener("blur", finish); };
  }, []);

  const chatDragOver = (event: import("react").DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(CHAT_DRAG_MIME)) return;
    const dock = currentDock.current, element = host.current;
    if (!dock || !element) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy";
    const group = dock.groups.find(group => group.element.contains(event.target as Node)) ?? dock.activeGroup ?? dock.groups[0];
    if (!group || !dropPreview.current) return;
    const rect = group.element.getBoundingClientRect(), parent = element.getBoundingClientRect();
    const position = chatDropPosition(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    const horizontal = position === "left" || position === "right", vertical = position === "above" || position === "below";
    Object.assign(dropPreview.current.style, { display: "grid", left: `${rect.left - parent.left + (position === "right" ? rect.width / 2 : 0) + 8}px`, top: `${rect.top - parent.top + (position === "below" ? rect.height / 2 : 0) + 8}px`, width: `${rect.width / (horizontal ? 2 : 1) - 16}px`, height: `${rect.height / (vertical ? 2 : 1) - 16}px` });
    dropPreview.current.textContent = position === "within" ? "Open as a tab" : "Open side by side";
  };
  const chatDrop = (event: import("react").DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(CHAT_DRAG_MIME)) return;
    event.preventDefault(); event.stopPropagation(); hideDropPreview(); clearNativeDragOverlays();
    const dock = currentDock.current;
    if (!dock || !host.current?.isConnected) return;
    const value = parseDockChatDrag(event.dataTransfer.getData(CHAT_DRAG_MIME), latest.current.primaryBackendId);
    if (!value) return;
    const group = dock.groups.find(group => group.element.contains(event.target as Node)) ?? dock.activeGroup ?? dock.groups[0];
    if (!group) return;
    const rect = group.element.getBoundingClientRect();
    const position = chatDropPosition(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    pendingDrop.current = { id: value.key, group: group.id, position };
    const primary = value.backendId === latest.current.primaryBackendId && value.id === latest.current.primarySessionId;
    const existing = dock.getPanel(primary ? "chat" : chatPanelId(value.key));
    if (existing) { existing.api.moveTo({ group, position: position === "above" ? "top" : position === "below" ? "bottom" : position === "within" ? "center" : position }); pendingDrop.current = undefined; }
    latest.current.onOpenChat?.(value.id, value.title, value.saved, value.backendId, resolved => {
      if (pendingDrop.current?.id === value.key) pendingDrop.current.id = chatResourceKey(resolved);
    });
  };
  const ready = useCallback(({ api: dock }: DockviewReadyEvent) => {
    // HMR can replace the Dockview instance while preserving this component's refs.
    // Retire old listeners before any new default layout can emit change events.
    if (currentDock.current && currentDock.current !== dock) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      pendingSave.current?.(); pendingSave.current = undefined;
      for (const item of disposables.current) item.dispose(); disposables.current = [];
    }
    currentDock.current = dock;
    lifecycle.current.activate(dock);
    dock.addPanel({ id: "chat", title: latest.current.primaryTitle, params:{closable:latest.current.primaryClosable,backendId:latest.current.primaryBackendId}, component: "slot", tabComponent: "tab", renderer: "always", minimumWidth: 240 });
    restore(dock);
    const persist = () => {
      const state = persistence.current;
      if (!lifecycle.current.accepts(dock,Boolean(host.current?.isConnected)) || currentDock.current !== dock || syncing.current || !state.restoreReady || restoredKey.current !== state.persistenceKey || restoredDock.current !== dock) return;
      const layout = dock.toJSON();
      if(!layout.panels.chat || !dock.getPanel("chat"))return;
      const save = state.setStoredLayout;
      lastSerialized.current = { key: state.persistenceKey, layout };
      pendingSave.current = () => save(layout);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { pendingSave.current?.(); pendingSave.current = undefined; }, 180);
    };
    captureLayout.current=persist;
    disposables.current.push(dock.onWillMutateLayout(event=>{
      // Only explicit UI close intents or our controlled reconciliation may remove views.
      // A library teardown can emit API removals while its DOM is still connected.
      if(event.kind === "remove" && !syncing.current && !lifecycle.current.hasCloseIntent(dock))lifecycle.current.deactivate();
    }));
    disposables.current.push(dock.onDidLayoutChange(persist));
    const flush = () => { persist(); if (saveTimer.current) clearTimeout(saveTimer.current); pendingSave.current?.(); pendingSave.current = undefined; };
    window.addEventListener("pagehide", flush);
    disposables.current.push({ dispose: () => window.removeEventListener("pagehide", flush) });
    disposables.current.push(dock.onDidActivePanelChange(event => {
      if(!lifecycle.current.accepts(dock,Boolean(host.current?.isConnected)) || event.origin!=="user" && !syncing.current)return;
      if (event.panel?.id === "chat" || event.panel?.id.startsWith("chat:")) {
        const id = event.panel.id;
        requestAnimationFrame(() => {if(lifecycle.current.accepts(dock,Boolean(host.current?.isConnected)))host.current?.querySelector<HTMLTextAreaElement>(`[data-dock-panel-id="${CSS.escape(id)}"] textarea[aria-autocomplete="list"]:not(:disabled)`)?.focus({preventScroll:true});});
      }
      if(event.origin!=="user")return;
      if (!syncing.current && isAux(event.panel?.id)) latest.current.onActivePanelChange(event.panel.id);
      if (!syncing.current && event.panel?.id.startsWith("chat:")) latest.current.onActiveChatChange?.(event.panel.id.slice(5));
      if (!syncing.current && event.panel?.id === "chat") latest.current.onActiveChatChange?.(null);
    }), dock.onDidRemovePanel(panel => {
      if (syncing.current || !lifecycle.current.accepts(dock,Boolean(host.current?.isConnected))) return;
      if(!lifecycle.current.consumeClose(dock,panel.id,true)){lifecycle.current.deactivate();return;}
      if(panel.id === "chat") {
        latest.current.onClosePrimary?.();
        queueMicrotask(()=>{
          if(lifecycle.current.accepts(dock,Boolean(host.current?.isConnected)) && !dock.getPanel("chat")) dock.addPanel({id:"chat",title:"New chat",params:{closable:false,backendId:latest.current.primaryBackendId},component:"slot",tabComponent:"tab",renderer:"always",minimumWidth:240,inactive:true,position:dock.panels[0]?{referencePanel:dock.panels[0].id,direction:"within"}:undefined});
        });
        return;
      }
      if (panel.id.startsWith("chat:")) { latest.current.onCloseChat?.(panel.id.slice(5)); return; }
      if (!isAux(panel.id)) return;
      const remaining = dock.panels.filter(item => isAux(item.id));
      const next = remaining.find(item => item.api.isActive) ?? remaining.at(-1);
      latest.current.onActivePanelChange(next && isAux(next.id) ? next.id : null);
    }));
    disposables.current.push(dock.onUnhandledDragOver(event => {
      if(!lifecycle.current.accepts(dock,Boolean(host.current?.isConnected)))return;
      if (event.nativeEvent instanceof DragEvent && event.nativeEvent.dataTransfer?.types.includes(CHAT_DRAG_MIME)) event.accept();
    }), dock.onDidDrop(event => {
      if(!lifecycle.current.accepts(dock,Boolean(host.current?.isConnected)))return;
      if (!(event.nativeEvent instanceof DragEvent)) return;
      const raw = event.nativeEvent.dataTransfer?.getData(CHAT_DRAG_MIME);
      if (!raw) return;
      const value=parseDockChatDrag(raw,latest.current.primaryBackendId);
      if(!value)return;
      pendingDrop.current={id:value.key,group:event.group?.id,position:event.position};
      const primary=value.backendId===latest.current.primaryBackendId && value.id===latest.current.primarySessionId;
      const existing=dock.getPanel(primary?"chat":chatPanelId(value.key));
      if(existing && event.group){existing.api.moveTo({group:event.group,position:event.position});pendingDrop.current=undefined;}
      latest.current.onOpenChat?.(value.id,value.title,value.saved,value.backendId,resolved=>{
        if(pendingDrop.current?.id===value.key)pendingDrop.current.id=chatResourceKey(resolved);
      });
    }));
    if (host.current) disposables.current.push(installDockMotion(dock,host.current));
    setApi(dock);
  }, []);
  useEffect(() => { if (api && restoreReady) restore(api); }, [api, persistenceKey, restoreReady, restore]);
  useEffect(() => {
    if (!api || !restoreReady || restoredKey.current !== persistenceKey) return;
    if (skipAuxReconcile.current) { skipAuxReconcile.current = false; return; }
    const changed = selectedAux.current !== activePanel; selectedAux.current = activePanel;
    syncing.current = true;
    try {
      if (!activePanel) {
        for (const panel of [...api.panels]) if (isAux(panel.id)) api.removePanel(panel);
        return;
      }
      const existing = api.getPanel(activePanel);
      if (existing) { if (changed) existing.api.setActive(); return; }
      const aux = api.panels.find(panel => isAux(panel.id));
      // New tools share one default group; users may subsequently drag out splits.
      const compact = window.matchMedia("(max-width: 767px)").matches;
      api.addPanel({ id: activePanel, title: titles[activePanel], component: "slot", tabComponent: "tab", renderer: "always", initialWidth: 420, minimumWidth: 240,
        position: aux ? { referencePanel: aux.id, direction: "within" } : { referencePanel: "chat", direction: compact ? "within" : "right" } });
    } finally { syncing.current = false; captureLayout.current?.(); }
  }, [api, activePanel, persistenceKey, restoreReady]);
  useEffect(() => {
    if (!api || !restoreReady || restoredKey.current !== persistenceKey) return;
    const preserveRestoredFocus=skipChatReconcile.current;skipChatReconcile.current=false;
    const changed = selectedChat.current !== activeChatId; selectedChat.current = activeChatId;
    syncing.current = true;
    try {
      const ids = new Set(extraChats.map(item => chatPanelId(dockChatKey(item,primaryBackendId))));
      // Replace the selected resource inside its existing split before retiring its old view.
      for (const item of extraChats) {
        const key = dockChatKey(item, primaryBackendId), nextId = chatPanelId(key);
        if (api.getPanel(nextId)) continue;
        const oldKey = Object.keys(chatIdRemap).find(old => chatIdRemap[old] === key && api.getPanel(chatPanelId(old)));
        if (!oldKey) continue;
        api.addPanel({ id: nextId, title: item.title, params: { backendId: item.backendId ?? primaryBackendId }, component: "slot", tabComponent: "tab", renderer: "always", minimumWidth: 240, inactive: true, position: { referencePanel: chatPanelId(oldKey), direction: "within" } });
      }
      for (const panel of [...api.panels]) if (panel.id.startsWith("chat:") && !ids.has(panel.id)) api.removePanel(panel);
      for (const item of extraChats) {
        const existing = api.getPanel(chatPanelId(dockChatKey(item,primaryBackendId)));
        if (existing) { if (existing.title !== item.title) existing.api.setTitle(item.title); existing.api.updateParameters({backendId:item.backendId??primaryBackendId}); continue; }
        const drop = pendingDrop.current?.id === dockChatKey(item,primaryBackendId) ? pendingDrop.current : undefined;
        const group = drop?.group && api.getGroup(drop.group);
        api.addPanel({ id: chatPanelId(dockChatKey(item,primaryBackendId)), title: item.title, params:{backendId:item.backendId??primaryBackendId}, component: "slot", tabComponent: "tab", renderer: "always", minimumWidth:240, inactive: true,
          position: group ? { referenceGroup: group.id, direction: drop?.position === "center" ? "within" : drop?.position as "left"|"right"|"above"|"below" } : { referencePanel: "chat", direction: "within" } });
        if (drop) pendingDrop.current = undefined;
      }
      if (changed && !preserveRestoredFocus) api.getPanel(activeChatId ? chatPanelId(activeChatId) : "chat")?.api.setActive();
      for (const group of api.groups) group.header.hidden = false;
    } finally { syncing.current = false; captureLayout.current?.(); }
  }, [api, extraChats.map(item => `${dockChatKey(item,primaryBackendId)}:${item.title}`).join("|"), activeChatId, persistenceKey, restoreReady]);
  useEffect(()=>{
    if(api) for(const group of api.groups) group.header.hidden=false;
    const primary=api?.getPanel("chat");
    if(!primary) return;
    if(primary.title!==primaryTitle) primary.api.setTitle(primaryTitle);
    primary.api.updateParameters({closable:primaryClosable,backendId:primaryBackendId});
  },[api,primaryTitle,primaryClosable]);
  const closePrimaryView = () => {
    const dock = currentDock.current;
    if (!dock) return;
    const replacement = dock.panels.find(panel => panel.id.startsWith("chat:") && panel.api.isActive) ?? dock.panels.find(panel => panel.id.startsWith("chat:"));
    const ref = replacement ? parseChatResourceKey(replacement.id.slice(5), primaryBackendId) : undefined;
    if (!replacement || !ref) { latest.current.onClosePrimary?.(); return; }
    const primary = dock.getPanel("chat");
    syncing.current = true;
    try {
      // Promote the surviving chat in its own group; never leave an empty primary split.
      primary?.api.moveTo({ group: replacement.group, position: "center" });
      dock.removePanel(replacement);
    } finally { syncing.current = false; }
    latest.current.onCloseChat?.(chatResourceKey(ref));
    latest.current.onActiveChatChange?.(null);
    latest.current.onClosePrimary?.(ref);
    primary?.api.setActive();
    captureLayout.current?.();
  };
  return <ClosePanel.Provider value={panel=>{const dock=currentDock.current;if(dock)lifecycle.current.close(dock,panel.id,Boolean(host.current?.isConnected),()=>panel.close());}}><ClosePrimary.Provider value={closePrimaryView}><Slots.Provider value={{ chat, "actions:chat":actions, ...panels, ...Object.fromEntries(extraChats.flatMap(item => [[chatPanelId(dockChatKey(item,primaryBackendId)), item.content], [`actions:${chatPanelId(dockChatKey(item,primaryBackendId))}`, item.actions]])) }}><div ref={host} className="console-dock-workspace" aria-label="Chat workspace" onDragEnterCapture={chatDragOver} onDragOverCapture={chatDragOver} onDropCapture={chatDrop} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) hideDropPreview(); }} onDragEnd={hideDropPreview}><div ref={dropPreview} aria-hidden="true" className="console-chat-drop-preview" /><DockviewReact components={components} tabComponents={tabComponents} rightHeaderActionsComponent={HeaderActions} onReady={ready} theme={themeDark} disableFloatingGroups getTabContextMenuItems={() => []} getTabGroupChipContextMenuItems={() => []} /></div></Slots.Provider></ClosePrimary.Provider></ClosePanel.Provider>;
}
