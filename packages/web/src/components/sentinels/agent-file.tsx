import { useEffect, useRef, useState } from "react";
import { FileText, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/ui/components/toast";
import { useSentinelClient } from "@/sentinels/api";
import { editedSinceApply, managedEditWarning, managedNote, type Sentinel } from "@/sentinels/model";

/** One line under the Agent name when a file defines it. */
export function AgentFileNote({ sentinel }: { sentinel: Sentinel }) {
  const note = managedNote(sentinel);
  if (!note) return null;
  return <p className="mt-1 text-xs text-muted-foreground-1" data-testid="agent-file-note">{note}{editedSinceApply(sentinel) ? ". Edited since the file was last applied." : ""}</p>;
}

/** One line beside the edit controls: the file wins on its next apply. */
export function AgentFileEditWarning({ sentinel }: { sentinel: Sentinel }) {
  const warning = managedEditWarning(sentinel);
  return warning ? <p role="note" className="text-sm text-muted-foreground-1">{warning}</p> : null;
}

/** Agent menu: Export as file copies the Agent as an Agent file to the clipboard. Nothing shows while it takes under 250 ms. */
export function AgentMenu({ sentinel }: { sentinel: Sentinel }) {
  const { client } = useSentinelClient();
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const exportFile = async () => {
    if (busy) return;
    setBusy(true);
    timer.current = setTimeout(() => setSlow(true), 250);
    try {
      const file = await client.exportFile(sentinel.id);
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(file.content);
      toast({ title: `Copied ${file.path}`, description: "Paste it into your repository, for example in .0/agents.", kind: "success" });
    } catch (cause) {
      toast({ title: "Couldn't copy the file", description: cause instanceof Error ? cause.message : undefined, kind: "error" });
    } finally { clearTimeout(timer.current); setSlow(false); setBusy(false); }
  };
  return <DropdownMenu>
    <Tooltip content="Agent menu" side="bottom"><DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Agent menu" />}><MoreHorizontal aria-hidden="true" /></DropdownMenu.Trigger></Tooltip>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item icon={<FileText aria-hidden="true" className="size-(--icon-sm)" />} disabled={busy} onClick={() => void exportFile()}>{slow ? "Copying" : "Export as file"}</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu>;
}
