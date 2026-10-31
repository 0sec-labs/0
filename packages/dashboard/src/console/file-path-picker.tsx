import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Popover } from "@cloudflare/kumo/components/popover";
import { ChevronDown, Folder } from "lucide-react";
import { useBackendApi } from "@/api";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader } from "@0/ui/components/loader";
import { cn } from "@/lib/utils";
import type { ConsoleWorkspace } from "./use-console-workspace";
import { WorkspaceDirectoryBrowser } from "./workspace-directory-browser";

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
  const { client, configureConsoleSession, webFetchJson } = useBackendApi();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [nativePending, setNativePending] = useState(false);
  const [nativeMessage, setNativeMessage] = useState<string | null>(null);
  const nativeRequest = useRef<AbortController | null>(null);
  const nativeGeneration = useRef(0);
  const nativeAvailable = client.backendId === "local" && typeof window !== "undefined" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
  const [browseRequest, setBrowseRequest] = useState({ path: cwd ?? "", revision: 0 });
  const navigate = useCallback((next: string) => {
    setPath(next); setBrowserOpen(true); setBrowseRequest(previous => ({ path: next, revision: previous.revision + 1 }));
  }, []);
  const loaded = useCallback((next: string) => setPath(previous => previous === browseRequest.path ? next : previous), [browseRequest.path]);
  const cancelNative = useCallback(() => {
    nativeGeneration.current++; nativeRequest.current?.abort(); nativeRequest.current = null; setNativePending(false);
  }, []);
  useEffect(() => { cancelNative(); setOpen(false); setBrowserOpen(false); setNativeMessage(null); }, [client, sessionId, disabled, cancelNative]);
  useEffect(() => () => { nativeGeneration.current++; nativeRequest.current?.abort(); }, []);
  const chooseNativeFolder = async () => {
    if (!nativeAvailable || nativeRequest.current || workspace.busy || workspaceDisabled || disabled) return;
    const controller = new AbortController(); nativeRequest.current = controller;
    const generation = ++nativeGeneration.current;
    setNativePending(true); setNativeMessage(null);
    try {
      const result = await webFetchJson<{ supported: boolean; path: string | null }>("/api/console/project/choose-directory", {
        method: "POST", body: JSON.stringify({ path: path.trim() || cwd }), signal: controller.signal,
      });
      if (controller.signal.aborted || client.signal.aborted || nativeGeneration.current !== generation) return;
      if (!result.supported) { setNativeMessage("The folder picker isn't available on this host. Browse folders below or enter a path."); navigate(path.trim()); }
      else if (result.path !== null) { setPath(result.path); setBrowserOpen(false); }
    } catch {
      if (!controller.signal.aborted && !client.signal.aborted && nativeGeneration.current === generation) {
        setNativeMessage("Couldn't open the folder picker. Browse folders below or enter a path."); navigate(path.trim());
      }
    } finally {
      if (nativeGeneration.current === generation) { nativeRequest.current = null; setNativePending(false); }
    }
  };
  const controlsDisabled = workspace.busy || workspaceDisabled || nativePending;
  const inputId = useId();
  const descriptionId = useId();

  return <Popover open={open && !disabled} onOpenChange={next => {
    setOpen(next);
    cancelNative(); setBrowserOpen(false); setNativeMessage(null);
    setPath(cwd ?? "");
    if (next) setBrowseRequest(previous => ({ path: cwd ?? "", revision: previous.revision + 1 }));
  }}>
    <Tooltip content={cwd ? `Workspace: ${cwd}` : "Choose workspace folder"}><Popover.Trigger render={<Button type="button" variant="ghost" size="sm" />}
      className={cn("min-w-0 shrink", className)} disabled={disabled || workspaceDisabled} aria-label={cwd ? `Change workspace: ${cwd}` : "Change workspace"}>
      <Folder className="size-4" />
      <span className="min-w-0 max-w-[min(24rem,55vw)] truncate text-left" dir="ltr">{cwd || "Choose folder"}</span>
      <ChevronDown className="size-3 text-muted-foreground" />
    </Popover.Trigger></Tooltip>
    <Popover.Content side="top" align="start" sideOffset={12} positionMethod="fixed"
      className="ui-menu-surface ui-menu-form w-96 max-w-[calc(100vw-24px)]">
      <Popover.Title className="text-sm font-medium">Change workspace</Popover.Title>
      <Popover.Description id={descriptionId} className="ui-menu-secondary mt-1">Choose the folder where Zero works.</Popover.Description>
      <form className="mt-3 space-y-2" onSubmit={event => {
        event.preventDefault();
        const value = path.trim();
        if (!value || disabled || controlsDisabled) return;
        void workspace.perform(() => configureConsoleSession(sessionId, { workspacePath: value })).then(result => { if (result) setOpen(false); });
      }}>
        {nativeAvailable ? <Button type="button" variant="secondary" className="w-full justify-start" disabled={controlsDisabled} aria-busy={nativePending || undefined} onClick={() => void chooseNativeFolder()}>
          {nativePending ? <Loader aria-hidden="true" /> : <Folder className="size-4" />}{nativePending ? "Opening folder picker…" : "Choose folder…"}
        </Button> : !browserOpen && <Button type="button" variant="secondary" className="w-full justify-start" disabled={controlsDisabled} onClick={() => navigate(path.trim())}><Folder className="size-4" />Browse folders</Button>}
        <label htmlFor={inputId} className="sr-only">Workspace folder path</label>
        <div className="flex gap-2"><Input id={inputId} autoComplete="off" data-1p-ignore data-lpignore="true" aria-describedby={descriptionId}
          placeholder="Or enter a folder path" value={path} disabled={controlsDisabled}
          onChange={event => setPath(event.target.value)} /><Button type="button" variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => navigate(path.trim())}>Open path</Button></div>
        {nativeMessage && <p role="status" className="text-xs text-muted-foreground">{nativeMessage}</p>}
        {nativeAvailable && !browserOpen && <Button type="button" variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => navigate(path.trim())}>Browse folders</Button>}
        {open && browserOpen && <WorkspaceDirectoryBrowser request={browseRequest} disabled={controlsDisabled} onNavigate={navigate} onLoaded={loaded} />}
        <div className="flex justify-end gap-2">
          <Popover.Close render={<Button type="button" variant="ghost" size="sm" />}>Cancel</Popover.Close>
          <Button type="submit" size="sm" disabled={controlsDisabled || !path.trim() || path.trim() === cwd}>Use folder</Button>
        </div>
      </form>
    </Popover.Content>
  </Popover>;
}
