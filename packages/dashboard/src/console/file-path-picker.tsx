import { useId, useState } from "react";
import { Popover } from "@cloudflare/kumo/components/popover";
import { ChevronDown, Folder } from "lucide-react";
import { useBackendApi } from "@/api";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ConsoleWorkspace } from "./use-console-workspace";

export interface FilePathPickerProps {
  workspace: ConsoleWorkspace;
  sessionId: string;
  cwd?: string;
  workspaceDisabled: boolean;
  disabled: boolean;
  className?: string;
}

/** Changes the session's working folder without shifting the composer. */
export function FilePathPicker({ workspace, sessionId, cwd, workspaceDisabled, disabled, className }: FilePathPickerProps) {
  const { configureConsoleSession } = useBackendApi();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const inputId = useId();
  const descriptionId = useId();

  return <Popover open={open && !disabled} onOpenChange={next => {
    setOpen(next);
    setPath(cwd ?? "");
  }}>
    <Tooltip content={cwd ? `Workspace: ${cwd}` : "Choose workspace folder"}><Popover.Trigger render={<Button type="button" variant="ghost" size="sm" />}
      className={cn("min-w-0 shrink", className)} disabled={disabled || workspaceDisabled} aria-label={cwd ? `Change workspace: ${cwd}` : "Change workspace"}>
      <Folder className="size-4" />
      <span className="min-w-0 max-w-[min(24rem,55vw)] truncate text-left" dir="ltr">{cwd || "Choose folder"}</span>
      <ChevronDown className="size-3 text-muted-foreground" />
    </Popover.Trigger></Tooltip>
    <Popover.Content side="top" align="start" sideOffset={12} positionMethod="fixed"
      className="ui-menu-surface ui-menu-form w-80">
      <Popover.Title className="text-sm font-medium">Change workspace</Popover.Title>
      <Popover.Description id={descriptionId} className="ui-menu-secondary mt-1">Choose the folder where Zero works.</Popover.Description>
      <form className="mt-3 space-y-2" onSubmit={event => {
        event.preventDefault();
        const value = path.trim();
        if (!value || disabled || workspaceDisabled || workspace.busy) return;
        void workspace.perform(() => configureConsoleSession(sessionId, { workspacePath: value })).then(result => { if (result) setOpen(false); });
      }}>
        <label htmlFor={inputId} className="sr-only">Workspace folder path</label>
        <Input id={inputId} autoFocus autoComplete="off" data-1p-ignore data-lpignore="true" aria-describedby={descriptionId}
          placeholder="/path/to/project" value={path} disabled={workspace.busy || workspaceDisabled}
          onChange={event => setPath(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Popover.Close render={<Button type="button" variant="ghost" size="sm" />}>Cancel</Popover.Close>
          <Button type="submit" size="sm" disabled={workspace.busy || workspaceDisabled || !path.trim() || path.trim() === cwd}>Use folder</Button>
        </div>
      </form>
    </Popover.Content>
  </Popover>;
}
