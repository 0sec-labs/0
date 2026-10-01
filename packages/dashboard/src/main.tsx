import React from "react";
import ReactDOM from "react-dom/client";
import { BackendShell } from "./backend-shell";
import "./styles.css";

document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";
document.documentElement.dataset.mode = "dark";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><BackendShell /></React.StrictMode>,
);
