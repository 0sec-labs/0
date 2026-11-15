import React from "react";
import ReactDOM from "react-dom/client";
import "../src/styles.css";
import "../src/color-themes.css";
import { TooltipProvider } from "../src/ui/components/tooltip";
import { MessageToolbar, MESSAGE_TOOLBAR_GUTTER } from "../src/console/message-toolbar";
import { Markdown } from "../src/console/markdown";
const q = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", q.get("theme") !== "light");
const iso = new Date().toISOString();
const code = "```ts\nconst answer = 42;\nconsole.log(answer);\n```";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <TooltipProvider><div className="mx-auto flex max-w-3xl flex-col gap-3 bg-background p-4 text-foreground">
    <div data-slot="user-message" className="flex min-w-0 flex-col items-end">
      <div data-rail className={`group/rail relative flex min-w-0 max-w-[77%] flex-col items-end ${MESSAGE_TOOLBAR_GUTTER}`}>
        <MessageToolbar iso={iso} text="Check prod workloads, errors and PRs" onReply={() => {}} link="https://x/#1" />
        <div data-text className="rounded-[var(--radius-card,8px)] bg-secondary px-3 py-2 text-sm"><p>Check prod workloads, errors and PRs</p></div>
      </div>
    </div>
    <div data-slot="agent-message" data-rail className={`group/rail relative min-w-0 ${MESSAGE_TOOLBAR_GUTTER}`}>
      <MessageToolbar iso={iso} text="Everything is healthy." align="left" onReply={() => {}} link="https://x/#2" />
      <div data-text><Markdown text={"Everything is healthy. Two PRs are open.\n\n" + code} /></div>
    </div>
  </div></TooltipProvider>);
