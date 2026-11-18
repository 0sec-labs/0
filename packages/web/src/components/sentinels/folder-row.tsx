import { useCallback, useState } from "react";
import { Check, ChevronDown, Folder } from "lucide-react";
import { Popover } from "@/ui/components/popover";
import { Button } from "@/components/ui/button";
import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import { WorkspaceDirectoryBrowser } from "@/console/workspace-directory-browser";
import { folderLabel, samePath } from "@/console/workspace-path";

const NO_RECENTS: string[] = [];

/** The folder or repository the sentinel works on: recent folders first, then a browser on this computer. */
export function FolderPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = usePersistentState<string[]>(STORAGE_KEYS.recentWorkspaces, NO_RECENTS);
  const [browsing, setBrowsing] = useState(false);
  const [request, setRequest] = useState({ path: value, revision: 0 });
  const [shown, setShown] = useState("");
  const loaded = useCallback((path: string) => setShown(path), []);
  const choose = (path: string) => {
    onChange(path);
    setRecents(previous => [path, ...(Array.isArray(previous) ? previous : []).filter(item => !samePath(item, path))].slice(0, 8));
    setOpen(false); setBrowsing(false);
  };
  const list = (Array.isArray(recents) ? recents : []).filter(item => typeof item === "string" && item.startsWith("/")).slice(0, 5);
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setBrowsing(false); }}>
    <Popover.Trigger aria-label="Folder" render={<Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-56 gap-1.5 font-normal" />}>
      <Folder aria-hidden="true" className="size-3.5 shrink-0 text-icon-muted" />
      <span className="min-w-0 truncate">{value ? folderLabel(value) : "Choose folder"}</span>
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-2" />
    </Popover.Trigger>
    <Popover.Content align="end" className="w-80 p-1.5">
      {browsing ? <div className="space-y-2 p-1">
        <WorkspaceDirectoryBrowser request={request} disabled={false} onNavigate={path => setRequest(previous => ({ path, revision: previous.revision + 1 }))} onLoaded={loaded} />
        <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-xs text-muted-foreground-1" title={shown}>{shown}</span><Button type="button" size="sm" variant="secondary" disabled={!shown} onClick={() => choose(shown)}>Use this folder</Button></div>
      </div> : <ul aria-label="Recent folders" className="flex flex-col">
        {list.map(path => <li key={path}><button type="button" onClick={() => choose(path)} className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-secondary focus-visible:bg-secondary"><span className="min-w-0 flex-1 truncate">{folderLabel(path)}<span className="ml-2 text-xs text-muted-foreground-2">{path}</span></span>{samePath(path, value) && <Check aria-hidden="true" className="size-3.5" />}</button></li>)}
        <li><button type="button" onClick={() => { setRequest(previous => ({ path: value, revision: previous.revision + 1 })); setBrowsing(true); }} className="flex min-h-7 w-full items-center rounded-md px-2 text-left text-[13px] outline-none hover:bg-secondary focus-visible:bg-secondary">Browse folders</button></li>
      </ul>}
    </Popover.Content>
  </Popover>;
}
