import { useId, useState } from "react";
import { Popover } from "@cloudflare/kumo/components/popover";
import { ArrowLeft, ChevronRight, FilePlus, Folder, Plus } from "lucide-react";
import { configureConsoleSession } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConsoleWorkspace } from "./use-console-workspace";

export interface FilePathPickerProps {
  workspace: ConsoleWorkspace;
  sessionId: string;
  cwd?: string;
  workspaceDisabled: boolean;
  onAdd: (path: string) => void;
  disabled: boolean;
  className?: string;
}

/** One context menu for the working folder and message references. */
export function FilePathPicker({ workspace, sessionId, cwd, workspaceDisabled, onAdd, disabled, className }: FilePathPickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "reference" | "workspace">("menu");
  const [path, setPath] = useState("");
  const inputId = useId();
  const descriptionId = useId();
  const folderName = cwd?.split("/").filter(Boolean).at(-1) || "Choose a workspace";

  return <Popover open={open && !disabled} onOpenChange={next => {
    setOpen(next);
    setView("menu");
    setPath("");
  }}>
    <Popover.Trigger render={<Button type="button" variant="ghost" size="icon-sm" />}
      className={className} disabled={disabled} aria-label="Add context" title="Add context">
      <Plus className="size-5" />
    </Popover.Trigger>
    <Popover.Content side="top" align="start" sideOffset={12} positionMethod="fixed"
      className="w-80 max-w-[calc(100vw-24px)] rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg outline-border motion-reduce:transition-none [&>[data-side]]:hidden [[data-reduced-motion=true]_&]:transition-none">
      {view === "menu" ? <>
        <Popover.Title className="sr-only">Workspace and context</Popover.Title>
        <Popover.Description className="sr-only">Choose a working folder or reference a file in your message.</Popover.Description>
        <button type="button" disabled={workspaceDisabled} title={cwd} onClick={() => { setPath(cwd ?? ""); setView("workspace"); }}
          className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted disabled:opacity-50">
          <Folder className="size-4 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{folderName}</span><span className="block text-xs text-muted-foreground">Change workspace</span></span><ChevronRight className="size-4 text-muted-foreground" />
        </button>
        <button type="button" onClick={() => { setPath(""); setView("reference"); }} className="flex w-full items-center gap-3 rounded-xl p-3 text-left text-sm hover:bg-muted">
          <FilePlus className="size-4" />Add a file reference
        </button>
      </> : <div className="p-2">
        <div className="flex items-center gap-2"><Button type="button" variant="ghost" size="icon-sm" aria-label="Back to context menu" onClick={() => setView("menu")}><ArrowLeft className="size-4" /></Button><Popover.Title className="text-sm font-medium">{view === "workspace" ? "Change workspace" : "Add a file reference"}</Popover.Title></div>
        <Popover.Description id={descriptionId} className="mt-2 text-xs leading-5 text-muted-foreground">{view === "workspace" ? "Choose where 0 works. Confirm folder access before it changes." : "Reference a file or folder on this computer."}</Popover.Description>
        <form className="mt-3 space-y-3" onSubmit={event => {
          event.preventDefault();
          const value = path.trim();
          if (!value || disabled) return;
          if (view === "workspace") {
            if (workspaceDisabled) return;
            void workspace.perform(() => configureConsoleSession(sessionId, { workspacePath: value })).then(result => { if (result) setOpen(false); });
          } else {
            onAdd(value);
            setOpen(false);
            setPath("");
          }
        }}>
          <label htmlFor={inputId} className="sr-only">{view === "workspace" ? "Workspace folder path" : "File or folder path"}</label>
          <Input key={view} id={inputId} autoFocus autoComplete="off" data-1p-ignore data-lpignore="true" aria-describedby={descriptionId}
            placeholder={view === "workspace" ? "/path/to/project" : "/path/to/file-or-folder"} value={path} disabled={workspace.busy}
            onChange={event => setPath(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Popover.Close render={<Button type="button" variant="ghost" size="sm" />}>Cancel</Popover.Close>
            <Button type="submit" size="sm" disabled={workspace.busy || !path.trim() || (view === "workspace" && (workspaceDisabled || path.trim() === cwd))}>{view === "workspace" ? "Use folder" : "Add reference"}</Button>
          </div>
        </form>
      </div>}
    </Popover.Content>
  </Popover>;
}
