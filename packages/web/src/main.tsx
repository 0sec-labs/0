import React from "react";
import ReactDOM from "react-dom/client";
import { BackendShell } from "./backend-shell";
import "./styles.css";
import "./color-themes.css";
import { TooltipProvider } from "./ui/components/tooltip";
import { initializeWebTheme } from "./lib/web-theme";
import { initializeWebAppearance } from "./lib/web-appearance";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { installCrashReporting, reportCrash } from "./lib/crash-reporting";

initializeWebTheme();
initializeWebAppearance();
installCrashReporting();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppErrorBoundary onError={reportCrash}><TooltipProvider><BackendShell /></TooltipProvider></AppErrorBoundary></React.StrictMode>,
);
