import { VOCAB, v } from "@/lib/vocabulary";
import { useState } from "react";
import { conversationLink } from "./conversation-link";
import { Button } from "@/components/ui/button";
import { NewChatButton } from "@/components/new-chat-button";
import { Link } from "react-router-dom";
import { CircleAlert, MessageCircleQuestion, Search, Trash2, Settings, ShieldCheck, Link2 } from "lucide-react";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
import { openAppSearch } from "@/components/search-events";
import { cn } from "@/lib/utils";
import { sessionTitlePending } from "./sidebar-chat-order";
import { LoadingDots } from "./loading-state";
import type { ConsoleWorkspace } from "./use-console-workspace";
import { orderSessionRail } from "./session-rail-order";
import { TeamAccount, useTeamAccess } from "@/components/team-access";
import { useBackendApi } from "@/api";
import { TeamPresenceAvatars } from "./team-collaboration";
import { useTeamOverview } from "./team-overview";

function SessionActivity({ status }: { status: DesktopConsoleSession["status"] }) {
  if (status === "ready" || status === "closed") return null;
  const label =
    status === "cancelling"
      ? "Stopping"
      : status === "working"
        ? "Responding"
        : status === "waiting"
          ? "Waiting for you"
          : "Needs attention";
  return (
    <span role="status" aria-label={label} title={label} className="flex size-7 shrink-0 items-center justify-center">
      {status === "working" || status === "cancelling" ? (
        <LoadingDots compact className="text-muted-foreground" />
      ) : status === "waiting" ? (
        <MessageCircleQuestion aria-hidden="true" className="size-4 text-amber-400" />
      ) : (
        <CircleAlert aria-hidden="true" className="size-4 text-red-400/80" />
      )}
    </span>
  );
}

export function ConsoleSessionRail({
  workspace,
  selectedId,
  onCreate,
  onDeleteLive,
  onResume,
  onDelete,
  onSelect,
  onOpenDockChat,
  showMobileFooter = true,
}: {
  workspace: ConsoleWorkspace;
  selectedId?: string;
  onCreate: () => void;
  onRename: (session: DesktopConsoleSession) => void;
  onArchiveLive: (session: DesktopConsoleSession) => void;
  onArchive: (saved: ConsoleSavedSession, archived: boolean) => void;
  onDeleteLive: (session: DesktopConsoleSession) => void;
  onResume: (saved: ConsoleSavedSession) => void;
  onDelete: (saved: ConsoleSavedSession) => void;
  onExport: (id: string, saved: boolean) => void;
  onSelect?: () => void;
  showMobileFooter?: boolean;
  onOpenDockChat?: (id: string, title: string) => void;
}) {
  const team = useTeamAccess();
  const { client, teamClient } = useBackendApi();
  const [copyStatus, setCopyStatus] = useState("");
  const copyLink = async (session: { id: string; savedId?: string }) => {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(conversationLink(window.location.origin, client.backendId, session));
      setCopyStatus("Conversation link copied.");
    } catch {
      setCopyStatus("Couldn’t copy the conversation link. Check clipboard permissions and try again.");
    }
  };
  const presence = useTeamOverview(teamClient, { enabled: team.enabled && Boolean(team.user) });
  const presenceFor = (id: string) =>
    presence.isError
      ? []
      : (presence.data?.rooms.find((room) => room.kind === "conversation" && room.id === id)?.presence ?? []);
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const live = workspace.sessions.filter(
    (session) =>
      session.status !== "closed" && (team.enabled || (session.messageCount ?? 0) > 0 || session.status !== "ready"),
  );
  const activeIds = new Set(
    workspace.sessions
      .filter((session) => session.status !== "closed")
      .flatMap((session) => [
        session.id,
        ...("savedId" in session && typeof session.savedId === "string" ? [session.savedId] : []),
      ]),
  );
  const saved = workspace.saved
    .filter((session) => (team.enabled || session.messageCount > 0) && !activeIds.has(session.id))
    .filter((session) => !session.archived);
  const rows = orderSessionRail(live, saved, workspace.saved);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-0.5 p-1">
        <Button
          variant="ghost"
          type="button"
          onClick={(event) => {
            const button = event.currentTarget;
            onSelect?.();
            openAppSearch("all", button);
          }}
          className="relative flex h-8 w-full justify-start items-center rounded-md pl-8 pr-3 text-left text-sm font-normal text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 size-4" />
          Search anything<kbd className="ml-auto rounded-md px-1 text-[10px] text-muted-foreground/70">⌘K</kbd>
        </Button>
      </div>
      <div
        id="chat-sidebar-list"
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto scroll-fade-y p-1"
        aria-label={v("{Missions}")}
      >
        {rows.map((row) => {
          if (row.kind === "live") {
            const session = row.session;
            return (
              <div
                key={row.key}
                className={cn(
                  "group relative flex h-7 items-center rounded-md",
                  selectedId === session.id ? "bg-secondary" : "hover:bg-secondary",
                )}
              >
                <Link
                  to={`/chats/${session.id}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-0-console-chat",
                      JSON.stringify({ sessionId: session.id, title: session.title || v("{Mission}") }),
                    );
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={(event) => {
                    if (
                      onOpenDockChat &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      !event.altKey &&
                      event.button === 0
                    ) {
                      event.preventDefault();
                      onOpenDockChat(session.id, session.title || v("{Mission}"));
                    }
                    onSelect?.();
                  }}
                  className="flex h-7 min-w-0 flex-1 justify-start items-center rounded-md px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  title={session.target || undefined}
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-left text-sm",
                      sessionTitlePending(session) && "ui-text-shimmer",
                    )}
                  >
                    {session.title || session.target || v("Untitled {mission}")}
                  </span>
                </Link>
                <SessionActivity status={session.status} />
                <TeamPresenceAvatars presence={presenceFor(session.id)} compact />
                <div className="absolute right-1 flex w-14 rounded-md bg-background group-hover:bg-[color-mix(in_oklch,var(--background),var(--foreground)_8%)] shrink-0 items-center pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 max-lg:pointer-events-auto max-lg:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                  <Button
                    variant="ghost"
                    type="button"
                    aria-label="Copy conversation link"
                    title="Copy conversation link"
                    onClick={() => void copyLink(session)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <Link2 aria-hidden="true" className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    aria-label={`Delete ${session.title || VOCAB.mission.singular}`}
                    title={v("Delete {mission}")}
                    disabled={workspace.busy || readOnlyTeam}
                    onClick={() => onDeleteLive(session)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              </div>
            );
          }
          const session = row.session;
          return (
            <div key={row.key} className="group relative flex h-7 items-center rounded-md hover:bg-secondary">
              <Button
                variant="ghost"
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    "application/x-0-console-chat",
                    JSON.stringify({
                      sessionId: session.id,
                      title: session.summary || session.target || v("Past {mission}"),
                      saved: true,
                    }),
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
                className="flex h-7 min-w-0 flex-1 justify-start items-center rounded-md px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 text-left"
                title={`${new Date(session.savedAt).toLocaleDateString()} · ${session.messageCount} messages`}
                onClick={() => onResume(session)}
              >
                <span className="min-w-0 flex-1 truncate text-left text-sm">
                  {session.summary || session.target || session.preview || v("Past {mission}")}
                </span>
              </Button>
              <TeamPresenceAvatars presence={presenceFor(session.id)} compact />
              <div className="absolute right-1 flex w-14 rounded-md bg-background group-hover:bg-[color-mix(in_oklch,var(--background),var(--foreground)_8%)] shrink-0 items-center pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 max-lg:pointer-events-auto max-lg:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                <Button
                  variant="ghost"
                  type="button"
                  aria-label="Copy conversation link"
                  title="Copy conversation link"
                  onClick={() => void copyLink(session)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <Link2 aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`Delete ${session.summary || session.target || VOCAB.mission.singular}`}
                  title={v("Delete {mission}")}
                  disabled={workspace.busy || readOnlyTeam}
                  onClick={() => onDelete(session)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
        {!rows.length && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">{v("No {missions} yet.")}</p>
        )}
      </div>
      {copyStatus && (
        <p role="status" className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
          {copyStatus}
        </p>
      )}
      {showMobileFooter && (
        <div className="space-y-2 p-3 lg:hidden">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <Link
              to={
                selectedId
                  ? `/settings?session=${encodeURIComponent(selectedId)}&return=${encodeURIComponent(`/chats/${selectedId}`)}`
                  : "/settings"
              }
              className="flex items-center gap-1.5 rounded-md px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Settings className="size-3.5" />
              Settings
            </Link>
            <Link
              to="/findings"
              className="flex items-center gap-1.5 rounded-md px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ShieldCheck className="size-3.5" />
              Findings
            </Link>
          </div>
          <TeamAccount />
        </div>
      )}
    </div>
  );
}
