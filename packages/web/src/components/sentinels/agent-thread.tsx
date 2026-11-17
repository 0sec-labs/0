import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUp } from "lucide-react";
import { errorText } from "@/lib/api-error";
import { agentComposerPlaceholder, agentFirstMessage } from "@/lib/agent-create-model";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { sentinelHref, type Sentinel } from "@/sentinels/model";
import { SentinelAvatar } from "./sentinel-avatar";

/**
 * An agent's own thread: big avatar and name, "View agent", its first message and the composer. Sending a message
 * starts a run with that task (an explicit, owner-written request) and opens the resulting chat.
 */
export function AgentThread({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const presets = useSentinelPresets();
  const { run } = useSentinelMutations();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const preset = presets.data?.find(item => item.id === sentinel.role);
  const archived = sentinel.status === "archived";
  const paused = sentinel.status === "paused";
  const blocked = readOnly || archived || paused;
  const send = async () => {
    const task = text.trim();
    if (!task || blocked || run.isPending) return;
    setError("");
    try {
      const result = await run.mutateAsync({ id: sentinel.id, version: sentinel.version, task });
      setText("");
      navigate(result.activation.missionId ? `/chats/${encodeURIComponent(result.activation.missionId)}` : sentinelHref(sentinel.id, "overview"));
    } catch (cause) { setError(errorText(cause, "Unable to send.")); }
  };
  return <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8" data-testid="agent-thread">
    <header className="flex flex-col items-center gap-2 pt-6 text-center">
      <SentinelAvatar sentinel={sentinel} size="xl" />
      <h1 className="font-sans text-[24px]/8 font-medium tracking-[-0.02em]">{sentinel.name}</h1>
      <Button variant="link" size="sm" render={<Link to={sentinelHref(sentinel.id, "overview")} />}>View agent</Button>
    </header>
    <div className="flex flex-col gap-2 text-sm" aria-label="Thread">
      {agentFirstMessage(sentinel, preset).map(line => <p key={line} className="max-w-prose rounded-(--radius-card) bg-secondary/60 px-4 py-3">{line}</p>)}
      {sentinel.homeMissionId && <Link to={`/chats/${encodeURIComponent(sentinel.homeMissionId)}`} className="text-xs text-muted-foreground-1 underline-offset-2 hover:underline">Open its earlier thread</Link>}
      {paused && <p role="status" className="text-xs text-muted-foreground-1">Paused. Turn it on from View agent to give it work.</p>}
      {archived && <p role="status" className="text-xs text-muted-foreground-1">Archived. It does not run.</p>}
    </div>
    <form className="mt-auto flex items-end gap-2 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-2" onSubmit={event => { event.preventDefault(); void send(); }}>
      <Textarea aria-label="Message" rows={2} value={text} disabled={blocked} maxLength={4000} placeholder={agentComposerPlaceholder(sentinel.name)} className="min-h-12 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <Button type="submit" size="icon" aria-label="Send" disabled={blocked || !text.trim() || run.isPending}><ArrowUp /></Button>
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
