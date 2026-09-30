import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, Blocks, FolderCheck, HeartPulse, KeyRound, MessageSquare, Monitor, Palette, Shield, Users, Rocket, Settings2, Sparkles, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectionsControl, ModelsControl } from "@/components/console-control/connections-control";
import { SettingsControl, settingsCategories, type SettingsCategory } from "@/components/console-control/settings-control";
import { PluginsControl } from "@/components/console-control/plugins-control";
import { DoctorControl, ProjectControl, ToolsControl } from "@/components/console-control/system-control";
import { LauncherControl, FixControl } from "@/components/console-control/workflow-control";
import { OnboardingControl } from "@/components/console-control/onboarding-control";
import { consoleReturn } from "@/components/console-control/control-ui";
import { cn } from "@/lib/utils";

export type WebConsoleControlMode = "onboarding" | "connections" | "models" | "settings" | "plugins" | "doctor" | "tools" | "project" | "launch" | "fix";

const pages = [
  { mode: "onboarding", path: "/setup", label: "Setup", icon: Sparkles, description: "Get started in a few steps. You can change everything later." },
  { mode: "connections", path: "/connections", label: "Connections", icon: KeyRound, description: "" },
  { mode: "models", path: "/models", label: "Models", icon: Sparkles, description: "" },
  { mode: "project", path: "/project", label: "Workspace", icon: FolderCheck, description: "" },
  { mode: "settings", path: "/settings", label: "General", icon: Settings2, description: "" },
  { mode: "plugins", path: "/plugins", label: "Plugins", icon: Blocks, description: "" },
  { mode: "doctor", path: "/doctor", label: "Health", icon: HeartPulse, description: "" },
  { mode: "tools", path: "/tools", label: "Tools", icon: Wrench, description: "" },
  { mode: "launch", path: "/audits", label: "Audits", icon: Rocket, description: "Plan and track security audits. Limits apply to the whole audit." },
  { mode: "fix", path: "/fix", label: "Fixes", icon: Wrench, description: "" },
] as const;

export function WebConsoleControlsPage({ mode: passedMode }: { mode?: WebConsoleControlMode }) {
  const location = useLocation();
  const headingRef = useRef<HTMLDivElement>(null);
  const leaf = location.pathname.replace(/^\/console\//, "/").replace(/\/$/, "");
  const mode = passedMode ?? (["/launch", "/launcher"].includes(leaf) ? "launch" : pages.find(page => page.path === leaf)?.mode) ?? "settings";
  const page = pages.find(item => item.mode === mode)!;
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session") ?? undefined;
  const category = settingsCategories.find(item => item.id === params.get("section"))?.id ?? "general";
  const returnTo = consoleReturn(location.search);
  const contextSearch = new URLSearchParams();
  if (sessionId) contextSearch.set("session", sessionId);
  contextSearch.set("return", returnTo);
  const suffix = `?${contextSearch}`;

  useEffect(() => { headingRef.current?.focus(); }, [mode]);

  const content = mode === "onboarding" ? <OnboardingControl sessionId={sessionId} returnTo={returnTo} />
    : mode === "connections" ? <ConnectionsControl />
    : mode === "models" ? <ModelsControl sessionId={sessionId} />
    : mode === "settings" ? <SettingsControl category={category} />
    : mode === "plugins" ? <PluginsControl sessionId={sessionId} />
    : mode === "doctor" ? <DoctorControl />
    : mode === "tools" ? <ToolsControl sessionId={sessionId} />
    : mode === "project" ? <ProjectControl sessionId={sessionId} />
    : mode === "launch" ? <LauncherControl sessionId={sessionId} />
    : <FixControl sessionId={sessionId} />;

  if (mode === "launch") {
    return <main aria-label="Audits" className="mx-auto w-full max-w-5xl space-y-6 px-5 py-6 sm:px-8 lg:px-10">{content}</main>;
  }

  const focused = mode === "onboarding";

  return <div className={cn("console-controls mx-auto w-full space-y-6 px-5 py-6 sm:px-8 lg:px-10", focused ? "max-w-5xl" : "max-w-4xl")}>
    {!focused && <div className="flex flex-wrap items-center justify-between gap-3"><Button asChild variant="ghost" size="sm"><Link to={returnTo}><ArrowLeft className="size-4" />Back to chat</Link></Button></div>}
    {!focused && <div ref={headingRef} tabIndex={-1} className="outline-none"><h1 className="text-xl font-semibold tracking-tight">{mode === "settings" ? settingsCategories.find(item => item.id === category)?.label : page.label}</h1>{!focused && page.description && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{page.description}</p>}</div>}
    {focused ? <main className="min-w-0 space-y-6" aria-label={page.label}>{content}</main> : <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <nav aria-label="Sections" className="flex gap-1 overflow-x-auto pb-2 lg:block lg:space-y-1 lg:overflow-visible">{settingsCategories.map(item => { const icons: Record<SettingsCategory, typeof Settings2> = { general: Settings2, appearance: Palette, conversation: MessageSquare, agents: Users, privacy: Shield, terminal: Monitor }; const Icon = icons[item.id]; return <Link key={item.id} to={`/settings${suffix}&section=${item.id}`} aria-current={mode === "settings" && category === item.id ? "page" : undefined} className={cn("flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors focus-visible:outline focus-visible:outline-offset-2", mode === "settings" && category === item.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><Icon className="size-4 shrink-0" />{item.label}</Link>; })}<div className="hidden py-2 lg:block" />{pages.filter(item => item.mode !== "launch" && item.mode !== "settings").map(item => <Link key={item.mode} to={`${item.path}${suffix}`} aria-current={mode === item.mode ? "page" : undefined} className={cn("flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:outline focus-visible:outline-offset-2", mode === item.mode ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><item.icon className="size-4 shrink-0" />{item.label}</Link>)}</nav>
      <main className="min-w-0 space-y-6" aria-label={page.label}>{content}</main>
    </div>}
  </div>;
}
