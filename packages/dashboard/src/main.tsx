import React from "react";
import ReactDOM from "react-dom/client";
import { BackendShell } from "./backend-shell";
import "./styles.css";
import { initializeWebTheme } from "./lib/web-theme";

initializeWebTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><BackendShell /></React.StrictMode>,
);
