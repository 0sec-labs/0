import { useEffect, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { CapyApiKeyIcon, CapyChipIcon, CapyGaugeIcon, CapyInboxIcon, CapyPlugIcon, CapyPullRequestIcon, CapySettingsIcon, CapyTerminalSparkleIcon } from "@/ui/icons/capy";
import { ConnectionsControl, ModelsControl } from "@/components/console-control/connections-control";
import { SettingsControl } from "@/components/console-control/settings-control";
import { settingsPageId, settingsPages, settingsRedirect } from "@/components/console-control/settings-index";
import { PluginsControl } from "@/components/console-control/plugins-control";
import { DoctorControl, ProjectControl, ToolsControl } from "@/components/console-control/system-control";
import { FixControl } from "@/components/console-control/workflow-control";

export type WebConsoleControlMode = "connections" | "models" | "settings" | "plugins" | "doctor" | "tools" | "project" | "fix";

const pages = [
  { mode: "connections", path: "/connections", label: "Connections", icon: CapyApiKeyIcon, description: "Subscriptions and API keys that power your models" },
  { mode: "models", path: "/models", label: "Models", icon: CapyChipIcon, description: "" },
  { mode: "project", path: "/project", label: "Workspace", icon: CapyInboxIcon, description: "" },
  { mode: "settings", path: "/settings", label: "Settings", icon: CapySettingsIcon, description: "" },
  { mode: "plugins", path: "/plugins", label: "Plugins", icon: CapyPlugIcon, description: "Teach 0 to work with the services your team uses" },
  { mode: "doctor", path: "/doctor", label: "Diagnostics", icon: CapyGaugeIcon, description: "" },
  { mode: "tools", path: "/tools", label: "Tools", icon: CapyTerminalSparkleIcon, description: "" },
  { mode: "fix", path: "/fix", label: "Fixes", icon: CapyPullRequestIcon, description: "" },
] as const;

export function WebConsoleControlsPage({ mode: passedMode }: { mode?: WebConsoleControlMode }) {
  const location = useLocation();
  const headingRef = useRef<HTMLElement>(null);
  const leaf = location.pathname.replace(/^\/console\//, "/").replace(/\/$/, "");
  const mode = passedMode ?? pages.find(page => page.path === leaf)?.mode ?? "settings";
  const page = pages.find(item => item.mode === mode)!;
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session") ?? undefined;
  const category = settingsPageId(params.get("section"));
  const redirect = mode === "settings" ? settingsRedirect(params.get("section")) : undefined;

  useEffect(() => { if (!location.hash) headingRef.current?.focus(); }, [mode, category, location.hash]);
  if (redirect) {
    // A removed or merged section: keep the session and return context, drop the old section name.
    const next = new URLSearchParams(location.search); next.delete("section");
    const [path, own] = redirect.split("?");
    const merged = new URLSearchParams(own); next.forEach((value, key) => { if (!merged.has(key)) merged.set(key, value); });
    const keep = path === "/settings" || path.startsWith("/plugins") ? `?${merged}` : "";
    return <Navigate replace to={{ pathname: path, search: keep, hash: location.hash }} />;
  }

  const content = mode === "connections" ? <ConnectionsControl />
    : mode === "models" ? <ModelsControl sessionId={sessionId} />
    : mode === "settings" ? <SettingsControl category={category} />
    : mode === "plugins" ? <PluginsControl sessionId={sessionId} />
    : mode === "doctor" ? <DoctorControl />
    : mode === "tools" ? <ToolsControl sessionId={sessionId} />
    : mode === "project" ? <ProjectControl sessionId={sessionId} />
    : <FixControl sessionId={sessionId} />;

  const title = mode === "settings" ? settingsPages.find(item => item.id === category)!.label : page.label;
  const wide = mode === "settings" && category === "shortcuts";
  const subtitle = wide ? "Keyboard shortcuts available in this app" : mode === "settings" ? undefined : page.description || undefined;
  return <div className={`[&_[data-slot=badge]]:rounded-full [&_[data-slot=badge]]:border-0 mx-auto flex w-full min-w-0 flex-col gap-10 px-6 pt-6 pb-10 md:pt-16 [[data-has-topbar]_&]:md:pt-12 ${wide ? "max-w-5xl" : "max-w-3xl"}`}>
    <header ref={headingRef} tabIndex={-1} className="flex flex-col gap-1 outline-none"><h1 className="text-xl font-medium break-words text-foreground">{title}</h1>{subtitle && <p className="text-sm font-normal text-muted-foreground-2">{subtitle}</p>}</header>
    <section className="flex min-w-0 flex-col gap-10" aria-label={mode === "settings" ? `${title} settings` : page.label}>{content}</section>
  </div>;
}
