import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { IDockviewHeaderActionsProps, IDockviewPanelHeaderProps, IDockviewPanelProps } from "dockview-react";
import { MessageSquare, X } from "lucide-react";
import { isBlankMissionTitle } from "@/lib/vocabulary";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ConnectedViewMenu, ViewMenuHeaderAction, isViewPanelId, viewDefinition, viewIdOfPanel } from "./panel";

export const Slots = createContext<Record<string, ReactNode>>({ chat: null });
export function Slot({ api }: IDockviewPanelProps) {
  const slots = useContext(Slots);
  return (
    <div data-dock-panel-id={api.id} className={`console-dock-slot console-dock-${api.id}`}>
      {slots[api.id]}
    </div>
  );
}
export function HeaderActions(props: IDockviewHeaderActionsProps) {
  const slots = useContext(Slots);
  const { activePanel, group } = props;
  if (!activePanel) return null;
  const hasViews = group.panels.some((panel) => isViewPanelId(panel.id));
  // Chat groups carry the `+` too, so the first view can be opened from an empty right side.
  return (
    <div className="console-dock-actions">
      {hasViews ? (
        <ViewMenuHeaderAction containerApi={props.containerApi} group={group} />
      ) : activePanel.id.startsWith("chat") ? (
        <ConnectedViewMenu />
      ) : null}
      {slots[`actions:${activePanel.id}`]}
    </div>
  );
}
export const ClosePanel = createContext<((api: IDockviewPanelHeaderProps["api"]) => void) | undefined>(undefined);
export const ClosePrimary = createContext<(() => void) | undefined>(undefined);
export function Tab({ api, params, containerApi }: IDockviewPanelHeaderProps) {
  const slots = useContext(Slots);
  const closePrimary = useContext(ClosePrimary);
  const closePanel = useContext(ClosePanel);
  const [title, setTitle] = useState(api.title);
  useEffect(() => {
    const listener = api.onDidTitleChange((event) => setTitle(event.title));
    return () => listener.dispose();
  }, [api]);
  // A group whose only visible tab is a chat shows a quiet title header instead of a pill.
  const [solo, setSolo] = useState(false);
  useEffect(() => {
    const update = () => {
      const panels = api.group?.panels ?? [];
      const visible = panels.filter(
        (panel) =>
          !(
            panel.id === "chat" &&
            panel.params?.closable !== true &&
            panels.some((other) => other.id.startsWith("chat:"))
          ),
      );
      setSolo(visible.length === 1 && visible[0].id === api.id && api.id.startsWith("chat"));
    };
    update();
    const subs = [
      containerApi.onDidAddPanel(update),
      containerApi.onDidRemovePanel(update),
      containerApi.onDidLayoutChange(update),
      api.onDidGroupChange(update),
    ];
    return () => subs.forEach((sub) => sub.dispose());
  }, [api, containerApi]);
  const viewId = viewIdOfPanel(api.id);
  const label = title || (viewId ? viewDefinition(viewId).title : "Conversation");
  const closable = viewId ? viewId !== "overview" : api.id !== "chat" || params?.closable === true;
  const owner = typeof params?.backendId === "string" ? params.backendId : undefined;
  const emptyPlaceholder = api.id === "chat" && !closable && Object.keys(slots).some((key) => key.startsWith("chat:"));
  const draft = solo && api.id === "chat" && isBlankMissionTitle(label);
  const Icon = viewId ? viewDefinition(viewId).icon : MessageSquare;
  return (
    <div
      className="console-dock-tab"
      data-solo={solo || undefined}
      data-draft={draft || undefined}
      data-empty-placeholder={emptyPlaceholder || undefined}
    >
      <Icon className="console-dock-tab-icon" aria-hidden="true" />
      <Tooltip
        content={
          owner ? (
            <>
              <span>{label}</span>
              <span className="block text-muted-foreground">Host: {owner}</span>
            </>
          ) : (
            label
          )
        }
      >
        <span className="console-dock-tab-label">{label}</span>
      </Tooltip>
      {closable && !solo && (
        <Tooltip content={owner ? `Close view on ${owner}` : "Close view"}>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={`Close ${label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (api.id === "chat") closePrimary?.();
              else closePanel?.(api);
            }}
          >
            <X size={13} />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}
