import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingChatSelection } from "@/components/host-sidebar-chat-history";

export type PendingChat = PendingChatSelection & { paneKey: string | null };

/**
 * Sidebar selections show a skeleton (and the chosen title) until the opened chat has content,
 * so a half-loaded chat can never flash the empty Home.
 */
export function usePendingChat({
  activeChatId,
  sessionId,
  backendId,
  pendingResolved,
}: {
  activeChatId: string | null;
  sessionId: string | undefined;
  backendId: string;
  pendingResolved: boolean;
}) {
  const [pendingChatSelection, setPendingChatSelection] = useState<PendingChat | null>(null);
  const pendingChatRef = useRef<PendingChat | null>(null);
  const showPendingChat = useCallback(
    (selection: PendingChatSelection | null) => {
      const next = selection ? { ...selection, paneKey: activeChatId } : null;
      pendingChatRef.current = next;
      setPendingChatSelection(next);
    },
    [activeChatId],
  );
  const isPendingChatCurrent = useCallback(
    (selection: PendingChatSelection) =>
      pendingChatRef.current?.id === selection.id && pendingChatRef.current?.backendId === selection.backendId,
    [],
  );
  const settledSession = useRef(`${backendId}:${sessionId}`);
  useEffect(() => {
    const key = `${backendId}:${sessionId}`;
    const pending = pendingChatRef.current;
    if (!pending) {
      settledSession.current = key;
      return;
    }
    if (settledSession.current === key) return;
    const arrived = pending.id === sessionId && pending.backendId === backendId;
    if (arrived && !pendingResolved) return;
    settledSession.current = key;
    pendingChatRef.current = null;
    setPendingChatSelection(null);
  }, [sessionId, backendId, pendingResolved, pendingChatSelection]);
  return { pendingChatSelection, pendingChatRef, showPendingChat, isPendingChatCurrent };
}
