import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { LoadingState } from "@/components/state-panel";
import { CapyArrowLeftIcon as ArrowLeft } from "@/ui/icons/capy";
import { PageContent, PageHeader } from "@/components/page-header";
import { Menu } from "lucide-react";
import { useMobileSidebar } from "@/ui/components/sidebar";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { useTeamAccess } from "@/components/team-access";
import { resumeSavedOnce } from "@/lib/lazy-resume";
import type { ConsolePublicMessage, ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { Markdown } from "@/console/markdown";
import { VisualBlock } from "@/console/visual-block";
import { partitionVisualCalls } from "@/console/visuals";
import { ToolActivity } from "@/console/tool-activity";
import { errorText } from "@/lib/api-error";

/** Browsing a retained transcript never resumes an execution or restores grants. */
const SAVED_WINDOW = 60;
export function SavedConversationPage() {
  const { savedId } = useParams();
  const { client, getSavedTranscript, resumeConsoleSession, sendConsoleMessage } = useBackendApi();
  const navigate = useNavigate();
  const drawer = useMobileSidebar();
  const queryClient = useQueryClient();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  // The newest window renders at once; older pages load on request. Servers without the transcript route return everything.
  const query = useQuery({
    queryKey: queryKeys.savedTranscript(client.backendId, savedId),
    queryFn: ({ signal }) => getSavedTranscript(savedId!, { window: SAVED_WINDOW }, signal),
    staleTime: 30_000,
  });
  const [older, setOlder] = useState<{
    savedId: string | undefined;
    messages: ConsolePublicMessage[];
    firstIndex: number;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const extra = older && older.savedId === savedId ? older : null;
  const firstIndex = extra?.firstIndex ?? query.data?.firstIndex ?? 0;
  const messages = [...(extra?.messages ?? []), ...(query.data?.messages ?? [])];
  const loadOlder = async () => {
    if (loadingOlder || firstIndex <= 0) return;
    setLoadingOlder(true);
    try {
      const page = await getSavedTranscript(savedId!, { before: firstIndex, limit: 50 });
      setOlder({ savedId, messages: [...page.messages, ...(extra?.messages ?? [])], firstIndex: page.firstIndex });
    } catch (cause) {
      setFailure(errorText(cause, "Couldn’t load earlier messages."));
    } finally {
      setLoadingOlder(false);
    }
  };
  // Open at the newest message, once per transcript (loading older pages must not yank the view).
  const endRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!query.data || scrolledFor.current === savedId) return;
    scrolledFor.current = savedId;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [query.data, savedId]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState("");
  const resuming = useRef<Promise<DesktopConsoleSession> | null>(null);
  /** Resume lazily (composer focus or send) and reuse the one live session for repeated opens. */
  const resume = () =>
    (resuming.current ??= resumeSavedOnce({
      backendId: client.backendId,
      savedId: savedId!,
      roster: queryClient.getQueryData<DesktopConsoleSession[]>(["console-sessions"]),
      resume: async () => {
        const session = await resumeConsoleSession(savedId!, {});
        queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], (previous) => [
          ...(previous ?? []).filter((item) => item.id !== session.id),
          session,
        ]);
        void queryClient.invalidateQueries({ queryKey: queryKeys.consoleSessions() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.consoleSaved() });
        return session;
      },
    }).catch((cause) => {
      resuming.current = null;
      throw cause;
    }));
  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setFailure("");
    try {
      const session = await resume();
      await sendConsoleMessage(session.id, { text });
      navigate(`/chats/${encodeURIComponent(session.id)}`);
    } catch (cause) {
      setFailure(errorText(cause, v("Couldn’t continue this {mission}. Try again.")));
      setSending(false);
    }
  };
  const results = new Map(
    messages.flatMap((message) =>
      message.content.flatMap((block) => (block.type === "tool_result" ? [[block.tool_use_id, block] as const] : [])),
    ),
  );
  return (
    <PageContent className="gap-6">
      <div className="flex items-center gap-1">
        {drawer && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            onClick={() => drawer.setOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="sm" render={<Link to="/chats" />}>
            <ArrowLeft aria-hidden="true" />
            {v("Back to {missions}")}
          </Button>
      </div>
      <PageHeader title={query.data?.meta.summary || v("Saved {mission}")} summary="Saved transcript" />
      {query.isPending ? (
        <LoadingState label={v("Loading {mission}…")} variant="detail" />
      ) : query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      ) : (
        [
          firstIndex > 0 && (
            <div key="earlier" className="flex justify-center">
              <Button type="button" variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </Button>
            </div>
          ),
          ...messages.map((message, index) => {
            const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
            const calls = message.content.flatMap((block) =>
              block.type === "tool_use"
                ? [
                    {
                      id: block.id,
                      name: block.name,
                      arguments: block.input,
                      result: results.get(block.id)?.content,
                      isRunning: false,
                    },
                  ]
                : [],
            );
            if (!text && !calls.length) return null;
            const { visuals, others } = partitionVisualCalls(calls);
            return (
              <article key={index} className="space-y-3">
                {message.role === "user" ? (
                  <div className="ml-auto max-w-[92%] rounded-[var(--radius-panel)] bg-muted/50 px-4 py-3 text-sm">
                    {message.author && (
                      <p className="mb-1 text-xs text-muted-foreground">{message.author.displayName}</p>
                    )}
                    <Markdown text={text} />
                  </div>
                ) : (
                  <>
                    {others.length > 0 && <ToolActivity calls={others} working={false} />}
                    {visuals.map((visual) => (
                      <VisualBlock key={visual.id} visual={visual} />
                    ))}
                    {text && <Markdown text={text} />}
                  </>
                )}
              </article>
            );
          }),
        ]
      )}
      <div ref={endRef} aria-hidden="true" />
      {!readOnly && query.data && (
        <form
          className="sticky bottom-0 space-y-2 bg-panel py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Textarea
            aria-label={v("Continue this {mission}")}
            placeholder={v("Continue this {mission}…")}
            value={draft}
            disabled={sending}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => {
              resume().catch(() => {});
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <Button type="submit" size="sm" disabled={sending || !draft.trim()}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </form>
      )}
    </PageContent>
  );
}
