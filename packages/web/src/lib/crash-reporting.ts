import { localControlFetch } from "@/api";
import { createCrashReporter, installWindowCrashListeners } from "./crash-report";

/** One reporter per page session, shared by the boundary and the window listeners. */
export const reportCrash = createCrashReporter({
  post: (body) => localControlFetch("/api/console/diagnostics/report", { method: "POST", body: JSON.stringify(body) }),
});

export function installCrashReporting(): () => void {
  return installWindowCrashListeners(window, reportCrash);
}
