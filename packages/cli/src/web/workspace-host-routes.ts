import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chooseWorkspaceFolder } from "./workspace-folder-picker.js";
import { folderChecks, type FolderCheck } from "./workspace-folder-check.js";
import { permissionMessageFor } from "./workspace-access.js";
import { normalizeWorkspaceInput } from "./workspace-input.js";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

const PRIVACY_PANES = {
  files: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
  fullDisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
} as const;

/** True only for a browser on the machine that runs the server: loopback socket and no reverse proxy in between. */
export function isLocalBrowserRequest(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
  const address = req.socket.remoteAddress ?? "";
  if (!(address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127."))) return false;
  return !req.headers["x-forwarded-for"] && !req.headers.forwarded && !req.headers["x-real-ip"];
}

interface HostRouteDependencies {
  platform?: NodeJS.Platform;
  open?: (url: string) => Promise<void>;
  choose?: typeof chooseWorkspaceFolder;
  checks?: Pick<typeof folderChecks, "check" | "cancel">;
}

const openUrl = (url: string) => new Promise<void>((resolve, reject) => {
  execFile("/usr/bin/open", [url], { timeout: 5_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
});

/**
 * Routes that act on the host machine's screen or settings. They are browser-only and owner-only (privileged-routes.ts)
 * and additionally refuse a browser that is not on the host, since the window would open on the wrong screen.
 */
export async function handleWorkspaceHostRequest(
  path: string, method: string, input: unknown, req: Pick<IncomingMessage, "socket" | "headers">, res: Pick<ServerResponse, "once" | "writableEnded">,
  dependencies: HostRouteDependencies = {},
): Promise<{ status: number; data: unknown } | null> {
  if (path !== "project/choose-directory" && path !== "project/open-privacy-settings" && path !== "project/check-directory") return null;
  if (method !== "POST") return { status: 405, data: { error: "Method not allowed." } };
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const local = isLocalBrowserRequest(req);
  if (path === "project/check-directory") return checkDirectory(body, local, dependencies.checks ?? folderChecks);
  const platform = dependencies.platform ?? process.platform;
  if (path === "project/choose-directory") {
    // Closing the popover aborts the request; that must close the dialog on the host too.
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    return { status: 200, data: await (dependencies.choose ?? chooseWorkspaceFolder)(body.path, { local, signal: controller.signal, platform }) };
  }
  if (platform !== "darwin") return { status: 400, data: { error: "Privacy settings are only available on macOS." } };
  if (!local) return { status: 403, data: { code: "host_only", error: "Open System Settings on the Mac that runs 0. This browser is on a different computer." } };
  const pane = body.pane === undefined ? "files" : body.pane;
  if (typeof pane !== "string" || !Object.hasOwn(PRIVACY_PANES, pane)) return { status: 400, data: { error: "Unknown privacy settings page." } };
  try { await (dependencies.open ?? openUrl)(PRIVACY_PANES[pane as keyof typeof PRIVACY_PANES]); }
  catch { return { status: 500, data: { error: "Couldn't open System Settings. Open it from the Apple menu, then Privacy & Security." } }; }
  return { status: 200, data: { opened: true } };
}

/**
 * Probes a folder without blocking the server and reports where it stands (checking, waiting for a macOS prompt, allowed,
 * blocked, timeout, error). Polling the same path joins the running probe; `retry` re-probes a finished refusal and
 * `cancel` stops it. The body path may be typed text (`~/Documents`), so it is resolved like the PATCH route does.
 */
async function checkDirectory(body: Record<string, unknown>, local: boolean, checks: Pick<typeof folderChecks, "check" | "cancel">): Promise<{ status: number; data: unknown }> {
  const raw = body.path;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4_096 || raw.includes("\0")) return { status: 400, data: { error: "Enter a folder path." } };
  const typed = resolve(normalizeWorkspaceInput(raw));
  let directory: string;
  try {
    directory = await realpath(typed);
    if (!(await stat(directory)).isDirectory()) return { status: 400, data: { error: "That path is a file. Choose the folder that contains it." } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Metadata of a protected folder is readable without a prompt; a refusal here is a real one.
    if (code === "EPERM" || code === "EACCES") return { status: 200, data: { state: "blocked", path: typed, folder: null, privacy: true, canPrompt: true, elapsedMs: 0, message: permissionMessageFor(typed, { error }) } satisfies FolderCheck };
    return { status: 200, data: { state: "error", path: typed, folder: null, canPrompt: true, elapsedMs: 0, message: "That folder doesn't exist. Check the path, or choose a folder from the list." } satisfies FolderCheck };
  }
  if (body.cancel === true) { checks.cancel(directory); return { status: 200, data: { cancelled: true, path: directory } }; }
  return { status: 200, data: checks.check(directory, { local, retry: body.retry === true }) };
}
