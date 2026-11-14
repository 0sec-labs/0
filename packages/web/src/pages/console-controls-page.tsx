import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { CapyApiKeyIcon, CapyChipIcon, CapyGaugeIcon, CapyInboxIcon, CapyPlugIcon, CapyPullRequestIcon, CapySettingsIcon, CapySparkleIcon, CapyTerminalSparkleIcon } from "@/ui/icons/capy";
import { PageContent } from "@/components/page-header";
import { ConnectionsControl, ModelsControl } from "@/components/console-control/connections-control";
import { SettingsControl } from "@/components/console-control/settings-control";
import { settingsPages } from "@/components/console-control/settings-index";
import { PluginsControl } from "@/components/console-control/plugins-control";
import { DoctorControl, ProjectControl, ToolsControl } from "@/components/console-control/system-control";
import { FixControl } from "@/components/console-control/workflow-control";
import { OnboardingControl } from "@/components/console-control/onboarding-control";
import { consoleReturn } from "@/components/console-control/control-ui";

export type WebConsoleControlMode = "onboarding" | "connections" | "models" | "settings" | "plugins" | "doctor" | "tools" | "project" | "fix";

const pages = [
  { mode: "onboarding", path: "/onboarding", label: "Onboarding", icon: CapySparkleIcon, description: "Get started in a few steps. You can change everything later." },
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
  const category = settingsPages.find(item => item.id === params.get("section"))?.id ?? "general";
  const returnTo = consoleReturn(location.search);

  useEffect(() => { if (!location.hash) headingRef.current?.focus(); }, [mode, category, location.hash]);

  const content = mode === "onboarding" ? <OnboardingControl sessionId={sessionId} returnTo={returnTo} />
    : mode === "connections" ? <ConnectionsControl />
    : mode === "models" ? <ModelsControl sessionId={sessionId} />
    : mode === "settings" ? <SettingsControl category={category} />
    : mode === "plugins" ? <PluginsControl sessionId={sessionId} />
    : mode === "doctor" ? <DoctorControl />
    : mode === "tools" ? <ToolsControl sessionId={sessionId} />
    : mode === "project" ? <ProjectControl sessionId={sessionId} />
    : <FixControl sessionId={sessionId} />;

  if (mode === "onboarding") return <PageContent className="[&_[data-slot=badge]]:rounded-full [&_[data-slot=badge]]:border-0">
    <section className="min-w-0 space-y-6" aria-label={page.label}>{content}</section>
  </PageContent>;

  const title = mode === "settings" ? settingsPages.find(item => item.id === category)!.label : page.label;
  const wide = mode === "settings" && category === "shortcuts";
  const subtitle = wide ? "Keyboard shortcuts available in this app" : mode === "settings" ? undefined : page.description || undefined;
  return <div className={`[&_[data-slot=badge]]:rounded-full [&_[data-slot=badge]]:border-0 mx-auto flex w-full min-w-0 flex-col gap-10 px-6 pt-6 pb-10 md:pt-16 ${wide ? "max-w-5xl" : "max-w-3xl"}`}>
    <header ref={headingRef} tabIndex={-1} className="flex flex-col gap-1 outline-none"><h1 className="text-xl font-medium break-words text-foreground">{title}</h1>{subtitle && <p className="text-sm font-normal text-muted-foreground-2">{subtitle}</p>}</header>
    <section className="flex min-w-0 flex-col gap-10" aria-label={mode === "settings" ? `${title} settings` : page.label}>{content}</section>
  </div>;
}
