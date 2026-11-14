import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Popover } from "@/ui/components/popover";
import { Check, ChevronDown, Folder, FolderOpen, Search } from "lucide-react";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useBackendApi } from "@/api";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader } from "../ui/components/loader";
import { cn } from "@/lib/utils";
import type { ConsoleWorkspace } from "./use-console-workspace";
import { WorkspaceDirectoryBrowser } from "./workspace-directory-browser";
import { STORAGE_KEYS } from "@/lib/storage";

/** Last path segment, tolerating trailing separators and Windows paths. */
function basename(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Project label: the folder name, with its parent when the name is too short to mean anything (e.g. `0sec-labs/0`). */
function projectLabel(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) ?? path;
  return last.length < 3 && parts.length > 1 ? `${parts.at(-2)}/${last}` : last;
}

const NO_RECENTS: string[] = [];
const ROW =
  "flex min-h-7 w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] font-[450] tracking-[-0.01em] text-foreground outline-none transition-colors hover:bg-[var(--popover-hover,var(--secondary))] focus-visible:bg-[var(--popover-hover,var(--secondary))] disabled:pointer-events-none disabled:opacity-50";

export interface FilePathPickerProps {
  workspace: ConsoleWorkspace;
  sessionId: string;
  cwd?: string;
  workspaceDisabled: boolean;
  disabled: boolean;
  className?: string;
  /** Capy status-rail chip: 24px, 12px text and icon. */
  rail?: boolean;
}

/** Changes the session's working folder without shifting the composer. */
export function FilePathPicker({
  workspace,
  sessionId,
  cwd,
  workspaceDisabled,
  disabled,
  className,
  rail = false,
}: FilePathPickerProps) {
  const { client, configureConsoleSession, webFetchJson } = useBackendApi();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [form, setForm] = useState(false);
  const [filter, setFilter] = useState("");
  const [recents, setRecents] = usePersistentState<string[]>(STORAGE_KEYS.recentWorkspaces, NO_RECENTS);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [nativePending, setNativePending] = useState(false);
  const [nativeMessage, setNativeMessage] = useState<string | null>(null);
  const nativeRequest = useRef<AbortController | null>(null);
  const nativeGeneration = useRef(0);
  const nativeAvailable =
    client.backendId === "local" &&
    typeof window !== "undefined" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
  const [browseRequest, setBrowseRequest] = useState({ path: cwd ?? "", revision: 0 });
  const navigate = useCallback((next: string) => {
    setPath(next);
    setBrowserOpen(true);
    setBrowseRequest((previous) => ({ path: next, revision: previous.revision + 1 }));
  }, []);
  const loaded = useCallback(
    (next: string) => setPath((previous) => (previous === browseRequest.path ? next : previous)),
    [browseRequest.path],
  );
  const cancelNative = useCallback(() => {
    nativeGeneration.current++;
    nativeRequest.current?.abort();
    nativeRequest.current = null;
    setNativePending(false);
  }, []);
  useEffect(() => {
    cancelNative();
    setOpen(false);
    setBrowserOpen(false);
    setNativeMessage(null);
  }, [client, sessionId, disabled, cancelNative]);
  useEffect(
    () => () => {
      nativeGeneration.current++;
      nativeRequest.current?.abort();
    },
    [],
  );
  const chooseNativeFolder = async () => {
    if (!nativeAvailable || nativeRequest.current || workspace.busy || workspaceDisabled || disabled) return;
    const controller = new AbortController();
    nativeRequest.current = controller;
    const generation = ++nativeGeneration.current;
    setNativePending(true);
    setNativeMessage(null);
    try {
      const result = await webFetchJson<{ supported: boolean; path: string | null }>(
        "/api/console/project/choose-directory",
        {
          method: "POST",
          body: JSON.stringify({ path: path.trim() || cwd }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || client.signal.aborted || nativeGeneration.current !== generation) return;
      if (!result.supported) {
        setNativeMessage("The folder picker isn't available on this host. Browse folders below or enter a path.");
        navigate(path.trim());
      } else if (result.path !== null) {
        setPath(result.path);
        setBrowserOpen(false);
      }
    } catch {
      if (!controller.signal.aborted && !client.signal.aborted && nativeGeneration.current === generation) {
        setNativeMessage("Couldn't open the folder picker. Browse folders below or enter a path.");
        navigate(path.trim());
      }
    } finally {
      if (nativeGeneration.current === generation) {
        nativeRequest.current = null;
        setNativePending(false);
      }
    }
  };
  useEffect(() => {
    if (cwd)
      setRecents((previous) =>
        (previous ?? NO_RECENTS)[0] === cwd
          ? previous
          : [cwd, ...(previous ?? NO_RECENTS).filter((item) => item !== cwd)].slice(0, 8),
      );
  }, [cwd, setRecents]);
  const folders = [...new Set([...(cwd ? [cwd] : []), ...(recents ?? NO_RECENTS)])].filter((item) =>
    item.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const controlsDisabled = workspace.busy || workspaceDisabled || nativePending;
  const inputId = useId();
  const descriptionId = useId();

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        setForm(false);
        setFilter("");
        cancelNative();
        setBrowserOpen(false);
        setNativeMessage(null);
        setPath(cwd ?? "");
        if (next) setBrowseRequest((previous) => ({ path: cwd ?? "", revision: previous.revision + 1 }));
      }}
    >
      <Tooltip content={cwd ? `Workspace: ${cwd}` : "Choose workspace folder"}>
        <Popover.Trigger
          className={cn(
            "inline-flex min-w-0 shrink items-center rounded-[6px] border-[0.5px] border-transparent font-medium tracking-[-0.01em] text-muted-foreground-1 outline-none transition-colors duration-100 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:text-foreground disabled:opacity-40",
            rail
              ? "h-6 gap-1.5 px-2 text-xs hover:bg-secondary data-[popup-open]:bg-secondary"
              : "-m-1 gap-1 p-1 text-sm",
            className,
          )}
          disabled={disabled || workspaceDisabled}
          aria-label={cwd ? `Change workspace: ${cwd}` : "Change workspace"}
        >
          <Folder
            aria-hidden="true"
            strokeWidth={1}
            className={cn("shrink-0 translate-y-[0.5px]", rail ? "size-3" : "size-3.5")}
          />
          <span className="min-w-0 max-w-[min(16rem,40vw)] truncate text-left" dir="ltr">
            {cwd ? projectLabel(cwd) : "Choose folder"}
          </span>
          <ChevronDown aria-hidden="true" strokeWidth={1} className="size-3.5 shrink-0 text-muted-foreground-3" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={4}
        positionMethod="fixed"
        className={cn(
          "max-h-[min(28rem,calc(100dvh-2rem))] max-w-[calc(100vw-24px)] overscroll-contain",
          form ? "w-96 p-3" : "w-64 gap-0 p-1",
        )}
      >
        {!form && (
          <>
            <Popover.Title className="sr-only">Change workspace</Popover.Title>
            <Popover.Description className="sr-only">
              {cwd ? `Current workspace: ${cwd}` : "Choose the folder where Zero works."}
            </Popover.Description>
            <div className="sticky top-0 z-10 -mx-1 -mt-1 bg-popover px-1 pt-1">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  strokeWidth={1.5}
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-icon-muted"
                />
                <input
                  type="text"
                  autoFocus
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  aria-label="Search projects"
                  placeholder="Search projects"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="block h-7 w-full bg-transparent pl-7 pr-2 text-[13px] font-[450] tracking-[-0.01em] text-foreground outline-none placeholder:text-muted-foreground-3"
                />
              </div>
              <div role="separator" className="-mx-1 my-1 h-px bg-border-1" />
            </div>
            <div role="group" aria-label="Recent workspaces" className="flex flex-col">
              {folders.map((item) => (
                <button
                  key={item}
                  type="button"
                  title={item}
                  className={ROW}
                  disabled={controlsDisabled || item === cwd}
                  aria-current={item === cwd ? "true" : undefined}
                  onClick={() => {
                    void workspace
                      .perform(() => configureConsoleSession(sessionId, { workspacePath: item }))
                      .then((result) => {
                        if (result) setOpen(false);
                      });
                  }}
                >
                  <Folder aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0 text-icon-muted" />
                  <span className="shrink-0 truncate">{basename(item)}</span>
                  <span dir="ltr" className="min-w-0 flex-1 truncate text-xs text-muted-foreground-2">
                    {item}
                  </span>
                  {item === cwd && <Check aria-hidden="true" className="size-3.5 shrink-0 text-foreground" />}
                </button>
              ))}
              {!folders.length && (
                <p className="px-2 py-1.5 text-[13px] text-muted-foreground-1">
                  {filter ? "No matching projects." : "No recent folders."}
                </p>
              )}
            </div>
            <div className="sticky bottom-0 -mx-1 -mb-1 bg-popover px-1 pb-1">
              <div role="separator" className="-mx-1 my-1 h-px bg-border-1" />
              <button
                type="button"
                className={ROW}
                disabled={controlsDisabled}
                onClick={() => {
                  setForm(true);
                  if (nativeAvailable) void chooseNativeFolder();
                  else navigate(path.trim());
                }}
              >
                <FolderOpen aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0 text-icon-muted" />
                Choose folder…
              </button>
              <button type="button" className={ROW} disabled={controlsDisabled} onClick={() => setForm(true)}>
                <Folder aria-hidden="true" strokeWidth={1.5} className="size-3.5 shrink-0 text-icon-muted" />
                Open path…
              </button>
            </div>
          </>
        )}
        {form && (
          <>
            <Popover.Title className="sticky top-0 z-10 flex min-h-[22px] items-center bg-popover text-xs font-medium text-muted-foreground-2">
              Change workspace
            </Popover.Title>
            <Popover.Description
              id={descriptionId}
              className="mt-1 truncate text-sm text-muted-foreground-1"
              title={cwd}
            >
              {cwd ? <span dir="ltr">{cwd}</span> : "Choose the folder where Zero works."}
            </Popover.Description>
            <form
              className="mt-3 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = path.trim();
                if (!value || disabled || controlsDisabled) return;
                void workspace
                  .perform(() => configureConsoleSession(sessionId, { workspacePath: value }))
                  .then((result) => {
                    if (result) setOpen(false);
                  });
              }}
            >
              {nativeAvailable ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="h-7 w-full justify-start"
                  disabled={controlsDisabled}
                  aria-busy={nativePending || undefined}
                  onClick={() => void chooseNativeFolder()}
                >
                  {nativePending ? <Loader aria-hidden="true" /> : <Folder className="size-4" />}
                  {nativePending ? "Opening folder picker…" : "Choose folder…"}
                </Button>
              ) : (
                !browserOpen && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-7 w-full justify-start"
                    disabled={controlsDisabled}
                    onClick={() => navigate(path.trim())}
                  >
                    <Folder className="size-4" />
                    Browse folders
                  </Button>
                )
              )}
              <label htmlFor={inputId} className="sr-only">
                Workspace folder path
              </label>
              <div className="flex gap-2">
                <Input
                  id={inputId}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  aria-describedby={descriptionId}
                  placeholder="Or enter a folder path"
                  value={path}
                  disabled={controlsDisabled}
                  onChange={(event) => setPath(event.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={() => navigate(path.trim())}
                >
                  Open path
                </Button>
              </div>
              {nativeMessage && (
                <p role="status" className="text-xs text-muted-foreground">
                  {nativeMessage}
                </p>
              )}
              {nativeAvailable && !browserOpen && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={() => navigate(path.trim())}
                >
                  Browse folders
                </Button>
              )}
              {open && browserOpen && (
                <WorkspaceDirectoryBrowser
                  request={browseRequest}
                  disabled={controlsDisabled}
                  onNavigate={navigate}
                  onLoaded={loaded}
                />
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setForm(false)}>
                  Back
                </Button>
                <Button type="submit" size="sm" disabled={controlsDisabled || !path.trim() || path.trim() === cwd}>
                  Use folder
                </Button>
              </div>
            </form>
          </>
        )}
      </Popover.Content>
    </Popover>
  );
}
