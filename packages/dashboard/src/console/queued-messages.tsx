import { ListOrdered, X } from "lucide-react";
import { Popover } from "@cloudflare/kumo/components/popover";
import type { ConsoleSessionSnapshot } from "@0/shared";
import { removeConsoleQueuedMessage } from "@/api";
import { Button } from "@/components/ui/button";
import type { ConsoleWorkspace } from "./use-console-workspace";

export function QueuedMessages({ workspace, snapshot }: {
  workspace: ConsoleWorkspace;
  snapshot: ConsoleSessionSnapshot;
}) {
  const count = snapshot.queuedMessages.length;
  const remove = (id?: string) => void workspace.perform(
    () => removeConsoleQueuedMessage(snapshot.session.id, id),
    snapshot.session.id,
  );

  return <Popover>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />}
      aria-label={`Queued messages ${count}`}
      title={`${count} queued message${count === 1 ? "" : "s"}`}
      className="gap-1.5 px-2 text-muted-foreground">
      <ListOrdered className="size-4" />
      <span className="text-xs tabular-nums">{count}</span>
    </Popover.Trigger>
    <Popover.Content side="top" align="end" sideOffset={10} positionMethod="fixed"
      className="flex w-80 max-w-[calc(100vw-24px)] flex-col rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <Popover.Title className="text-sm font-medium">Queued messages · {count}</Popover.Title>
        <Popover.Close render={<Button variant="ghost" size="icon-xs" />} aria-label="Close queued messages">
          <X className="size-3.5" />
        </Popover.Close>
      </div>
      <Popover.Description className="mt-1 text-xs text-muted-foreground">
        Messages to send after the current response.
      </Popover.Description>
      {count > 0 ? <>
        <ol className="mt-3 max-h-56 min-h-0 space-y-1 overflow-y-auto overscroll-contain">
          {snapshot.queuedMessages.map((message, index) => <li key={message.id}
            className="flex items-start gap-2 rounded-xl px-2 py-2 hover:bg-muted/60">
            <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground" aria-hidden="true">{index + 1}</span>
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{message.text}</p>
            <Button variant="ghost" size="icon-xs" disabled={workspace.busy}
              aria-label={`Remove queued message ${index + 1}`} title="Remove message" onClick={() => remove(message.id)}>
              <X className="size-3.5" />
            </Button>
          </li>)}
        </ol>
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" disabled={workspace.busy} onClick={() => remove()}>Clear queue</Button>
        </div>
      </> : <p className="py-4 text-sm text-muted-foreground">No queued messages.</p>}
    </Popover.Content>
  </Popover>;
}
