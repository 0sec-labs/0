import React from "react";
import ReactDOM from "react-dom/client";
import { BackendShell } from "./backend-shell";
import "./styles.css";
import { TooltipProvider } from "./ui/components/tooltip";
import { initializeWebTheme } from "./lib/web-theme";
import { initializeWebAppearance } from "./lib/web-appearance";

initializeWebTheme();
initializeWebAppearance();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><TooltipProvider><BackendShell /></TooltipProvider></React.StrictMode>,
);
