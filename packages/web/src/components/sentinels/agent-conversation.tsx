import { useEffect, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useBackendApi } from "@/api";
import { errorText } from "@/lib/api-error";
import { STORAGE_KEYS } from "@/lib/storage";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useConsoleWorkspace } from "@/console/use-console-workspace";
import { Conversation } from "@/console/conversation";
import { ConversationSkeleton } from "@/console/loading-state";
import { AgentTurnsContext } from "@/console/agent-turns-context";
import { CostButton } from "@/console/panel/cost-popover";
import { Button } from "@/components/ui/button";
import { agentComposerPlaceholder } from "@/lib/agent-create-model";
import { useAgentTurns, useSentinelClient, useSentinelMutations } from "@/sentinels/api";
import type { AgentTurn, Sentinel } from "@/sentinels/model";
import { SentinelAvatar } from "./sentinel-avatar";

/**
 * The Agent's one thread, as the real conversation: the same transcript and composer every thread has, so a message typed
 * here goes into the thread and nothing navigates away. Trigger turns show as quiet wake-up lines (see agent-wake-line).
 * The thread is opened (restored after a restart, or created) through the Agent's own endpoint; it is never replaced.
 */
export function AgentConversation({ sentinel, readOnly, onViewAgent }: { sentinel: Sentinel; readOnly: boolean; onViewAgent: () => void }) {
  const api = useBackendApi();
  const { client: sentinels } = useSentinelClient();
  const { setPaused } = useSentinelMutations();
  const [missionId, setMissionId] = useState<string | null>(readOnly ? sentinel.homeMissionId : null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const archived = sentinel.status === "archived";
  const paused = sentinel.status === "paused";

  useEffect(() => {
    if (readOnly) { setMissionId(sentinel.homeMissionId); return; }
    let live = true;
    setMissionId(null);
    sentinels.thread(sentinel.id).then(result => { if (live) { setMissionId(result.missionId); setError(""); } }).catch(cause => { if (live) setError(errorText(cause, "Couldn't open this thread.")); });
    return () => { live = false; };
  }, [sentinel.id, readOnly, attempt, sentinels]);

  const workspace = useConsoleWorkspace(missionId ?? undefined, workerId);
  const snapshot = workspace.snapshot;
  const turns = useAgentTurns(sentinel.id);
  const byNonce = useMemo(() => new Map<string, AgentTurn>((turns.data ?? []).map(turn => [turn.id.slice(0, 8), turn])), [turns.data]);
  const active = snapshot ? ["working", "waiting"].includes(snapshot.session.status) : false;

  const send = () => {
    if (!snapshot || readOnly) return;
    const text = workspace.readDraft(true).trim();
    const attachments = workspace.rootAttachments;
    if (!text && !attachments.length) return;
    // A turn that woke on its own is never interrupted by a person's message: it waits its turn.
    void workspace.send({ text, attachments: attachments.map(({ kind, value, name }) => ({ kind, value, name })), mode: active ? "queue" : "send" });
  };
  const stop = () => { if (missionId) void workspace.perform(() => api.controlConsoleSession(missionId, "cancel")); };
  const toggle = () => void setPaused.mutateAsync({ id: sentinel.id, paused: !paused, version: sentinel.version }).catch(() => undefined);

  return <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="agent-thread" data-agent-status={sentinel.status}>
    <header className="flex h-11 shrink-0 items-center gap-2.5 border-b-[0.5px] border-border-1 px-4">
      <SentinelAvatar sentinel={sentinel} size="xs" />
      <h1 className="min-w-0 truncate font-sans text-sm font-medium tracking-[-0.01em]">{sentinel.name}</h1>
      {paused && <span className="flex-none text-xs text-muted-foreground-1">Paused</span>}
      <span className="ml-auto flex items-center gap-1">
        <CostButton snapshot={snapshot ?? undefined} />
        {!readOnly && !archived && <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={setPaused.isPending} aria-label={paused ? "Resume" : "Pause"} onClick={toggle}>{paused ? <Play aria-hidden="true" className="size-3" /> : <Pause aria-hidden="true" className="size-3" />}{paused ? "Resume" : "Pause"}</Button>}
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onViewAgent}>View agent</Button>
      </span>
    </header>
    {(paused || archived) && <div className="shrink-0 border-b-[0.5px] border-border-1 px-4 py-2 text-xs text-muted-foreground">
      {archived ? "Archived. It does not wake on its own. Its thread stays here."
        : "Paused. Schedules and triggers are off. You can still talk to it."}
    </div>}
    {error && !snapshot ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground"><p>{error}</p><Button size="sm" variant="secondary" onClick={() => setAttempt(count => count + 1)}>Try again</Button></div>
      : !missionId ? (readOnly ? <p className="p-6 text-sm text-muted-foreground">It has no thread yet.</p> : <ConversationSkeleton />)
      : !snapshot ? (workspace.error ? <div role="alert" className="p-6 text-sm text-destructive">{workspace.error}</div> : <ConversationSkeleton />)
      : <AgentTurnsContext value={byNonce}>
        <div className="relative flex min-h-0 flex-1 flex-col">
        <Conversation workspace={workspace} worker={undefined} sendBehavior="queue" composerPlaceholder={agentComposerPlaceholder(sentinel.name)}
          emptyState={<div className="max-w-xs space-y-2 text-center"><SentinelAvatar sentinel={sentinel} size="lg" className="mx-auto" /><h2 className="text-lg font-medium tracking-tight">{sentinel.name}</h2><p className="text-sm leading-6 text-muted-foreground">{sentinel.mission || "Tell it what to watch and what to do."}</p></div>}
          onSubmitRoot={send} onSubmit={send} onStopRoot={stop} onStop={stop}
          onResolve={(id, response) => void workspace.perform(() => api.resolveConsoleDecision(snapshot.session.id, id, response))}
          resumeCap={() => void workspace.send({ text: "Continue from where you stopped.", mode: "send" })}
          onSelectWorker={setWorkerId} />
        </div>
      </AgentTurnsContext>}
  </div>;
}
