import { useState } from "react";
import type { ConsoleMessageInput, ConsoleSessionSnapshot, TurnEndingKind } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { useProviders } from "@/components/console-control/connections-control";
import { rememberModelChoice } from "@/lib/last-model-choice";
import { configureChatRuntime } from "./model-source";
import { nextHealthyChoice } from "./provider-health";
import { useModelCatalog } from "./use-model-catalog";
import { TURN_ENDING_ACTIONS, TURN_ENDING_TEXT } from "./turn-ending";

type Message = { text: string; attachments?: ConsoleMessageInput["attachments"] };

const action =
  "min-h-6 rounded-[var(--radius-inner,4px)] px-1 text-xs font-medium text-foreground underline-offset-2 transition-colors hover:underline focus-visible:outline-ring-inset disabled:opacity-50 disabled:no-underline";

/** Another model than the one that just came back empty; switching re-runs the turn in place. */
function SwitchModel({ snapshot, message, onRetry, disabled }: { snapshot: ConsoleSessionSnapshot; message: Message; onRetry: (message: Message) => void; disabled: boolean }) {
  const api = useBackendApi();
  const providers = useProviders();
  const catalog = useModelCatalog({ backendId: api.client.backendId, webFetchJson: api.webFetchJson });
  const [switching, setSwitching] = useState(false);
  const current = snapshot.runtime;
  const isCurrent = (providerId: string, model: string) => providerId === current?.providerId && model === current?.model;
  const next = nextHealthyChoice({
    providers: providers.data?.providers ?? [],
    models: (catalog.data?.models ?? []).filter((row) => !isCurrent(row.provider, row.id)),
    recommended: (catalog.data?.recommended ?? []).filter((item) => !isCurrent(item.providerId, item.model)),
  });
  if (!next) return null;
  const run = async () => {
    setSwitching(true);
    try {
      await configureChatRuntime(api, snapshot.session.id, { providerId: next.providerId, model: next.model }, snapshot.runtime);
      rememberModelChoice(api.client.backendId, { providerId: next.providerId, model: next.model });
      onRetry(message);
    } catch {
      // The model menu in the composer is still there; nothing else to say.
    } finally {
      setSwitching(false);
    }
  };
  return (
    <button type="button" className={action} disabled={disabled || switching} title={`Switch to ${next.model} and retry`} onClick={() => void run()}>
      {switching ? "Switching…" : "Switch model"}
    </button>
  );
}

/**
 * One quiet line under the user message when a turn finished without a visible answer. Partial progress stays
 * above it; Retry re-runs the turn in place, Continue asks the model to carry on from a cut-off reply.
 */
export function TurnEndingRow({ kind, detail, snapshot, message, interactive, busy, onRetry, onContinue }: {
  kind: TurnEndingKind;
  /** The raw provider message, kept for hover and support rather than shown. */
  detail?: string;
  snapshot: ConsoleSessionSnapshot;
  message: Message;
  /** The latest turn of an idle thread the viewer can write to. */
  interactive: boolean;
  busy: boolean;
  onRetry?: (message: Message) => void;
  onContinue?: () => void;
}) {
  const actions = TURN_ENDING_ACTIONS[kind];
  return (
    <div role="status" data-turn-ending={kind} title={detail} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-xs text-muted-foreground-1">
      <span>{TURN_ENDING_TEXT[kind]}</span>
      {interactive && actions.retry && onRetry && (
        <button type="button" className={action} disabled={busy} onClick={() => onRetry(message)}>
          Retry
        </button>
      )}
      {interactive && actions.continue && onContinue && (
        <button type="button" className={action} disabled={busy} onClick={onContinue}>
          Continue
        </button>
      )}
      {interactive && actions.switchModel && onRetry && <SwitchModel snapshot={snapshot} message={message} onRetry={onRetry} disabled={busy} />}
    </div>
  );
}
