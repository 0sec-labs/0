/** Stable working link: recovery resolves the saved ID without restoring old grants. */
export function conversationLink(origin: string, backendId: string, session: { id: string; savedId?: string }): string {
  const url = new URL(`/chats/${encodeURIComponent(session.savedId ?? session.id)}`, origin);
  url.searchParams.set("host", backendId);
  return url.href;
}
