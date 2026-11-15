import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chooseWorkspaceFolder } from "./workspace-folder-picker.js";

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
  if (path !== "project/choose-directory" && path !== "project/open-privacy-settings") return null;
  if (method !== "POST") return { status: 405, data: { error: "Method not allowed." } };
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const local = isLocalBrowserRequest(req);
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
