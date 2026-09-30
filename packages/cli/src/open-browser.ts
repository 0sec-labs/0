import { spawn } from "node:child_process";
import { platform } from "node:os";

/** Launch a provider sign-in or installation URL without invoking a shell. */
export function defaultOpenBrowser(url: string): Promise<void> {
  const plat = platform();
  return new Promise<void>((resolve, reject) => {
    const options = { detached: true, stdio: "ignore" as const, shell: false };
    // cmd /c start interprets URL metacharacters even though spawn uses no shell.
    // Pass the URL as data on Windows, never interpolate it into PowerShell code.
    const child = plat === "darwin"
      ? spawn("open", [url], options)
      : plat === "win32"
        ? spawn("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          "Start-Process -FilePath $env:OSEC_BROWSER_LOGIN_URL",
        ], { ...options, env: { ...process.env, OSEC_BROWSER_LOGIN_URL: url } })
        : spawn("xdg-open", [url], options);
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
