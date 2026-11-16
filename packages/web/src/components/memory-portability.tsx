import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { CapyMoreIcon as MoreHorizontal } from "@/ui/icons/capy";
import { errorText } from "@/lib/api-error";

/** Export, import and turn-off for Memory. The server does the work; this only moves a file. */
export function MemoryMenu({ enabled, count, readOnly, onForgetAll, onError }: { enabled: boolean; count: number; readOnly: boolean; onForgetAll: () => void; onError: (message: string) => void }) {
  const { client, webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const refresh = () => cache.invalidateQueries({ queryKey: queryKeys.consoleMemory(client.backendId) });
  const exportNotes = async () => {
    try {
      const data = await webFetchJson<unknown>("/api/console/memory/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `0-memory-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { onError(errorText(cause, "Couldn’t export memory.")); }
  };
  const importFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    try {
      if (chosen.size > 1_048_576) throw new Error("Choose a JSON file smaller than 1 MB.");
      const result = await webFetchJson<{ added: number; total: number }>("/api/console/memory/import", { method: "POST", body: JSON.stringify({ archive: JSON.parse(await chosen.text()) }) });
      setStatus(`Added ${result.added} of ${result.total} notes.`); await refresh();
    } catch (cause) { onError(cause instanceof SyntaxError ? "This file isn’t valid JSON." : errorText(cause, "Couldn’t import memory.")); }
    finally { if (file.current) file.current.value = ""; }
  };
  const toggle = async () => {
    try { await webFetchJson("/api/console/memory/enabled", { method: "POST", body: JSON.stringify({ enabled: !enabled }) }); await refresh(); } catch (cause) { onError(errorText(cause, "Couldn’t change this.")); }
  };
  return <div className="flex items-center gap-2">
    {status && <span role="status" className="text-xs text-muted-foreground">{status}</span>}
    <input ref={file} type="file" accept=".json,application/json" aria-label="Memory file" className="hidden" onChange={event => void importFile(event.currentTarget.files?.[0])} />
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="More memory actions" />}><MoreHorizontal className="size-4" /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item onClick={() => void exportNotes()} disabled={!count}>Export</DropdownMenu.Item>
        {!readOnly && <DropdownMenu.Item onClick={() => file.current?.click()}>Import</DropdownMenu.Item>}
        {!readOnly && <DropdownMenu.Item onClick={() => void toggle()}>{enabled ? "Turn off for new threads" : "Turn on for new threads"}</DropdownMenu.Item>}
        {!readOnly && <DropdownMenu.Item onClick={onForgetAll} disabled={!count}>Forget all</DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu>
  </div>;
}
