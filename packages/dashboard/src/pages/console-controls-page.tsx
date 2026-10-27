import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, Blocks, FolderCheck, HeartPulse, KeyRound, Rocket, Settings2, Sparkles, Wrench } from "lucide-react";
import { PageHeader, PageContent } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ConnectionsControl, ModelsControl } from "@/components/console-control/connections-control";
import { SettingsControl, settingsCategories } from "@/components/console-control/settings-control";
import { PluginsControl } from "@/components/console-control/plugins-control";
import { DoctorControl, ProjectControl, ToolsControl } from "@/components/console-control/system-control";
import { LauncherControl, FixControl } from "@/components/console-control/workflow-control";
import { OnboardingControl } from "@/components/console-control/onboarding-control";
import { consoleReturn } from "@/components/console-control/control-ui";

export type WebConsoleControlMode = "onboarding" | "connections" | "models" | "settings" | "plugins" | "doctor" | "tools" | "project" | "launch" | "fix";

const pages = [
  { mode: "onboarding", path: "/onboarding", label: "Onboarding", icon: Sparkles, description: "Get started in a few steps. You can change everything later." },
  { mode: "connections", path: "/connections", label: "Connections", icon: KeyRound, description: "" },
  { mode: "models", path: "/models", label: "Models", icon: Sparkles, description: "" },
  { mode: "project", path: "/project", label: "Workspace", icon: FolderCheck, description: "" },
  { mode: "settings", path: "/settings", label: "Settings", icon: Settings2, description: "" },
  { mode: "plugins", path: "/plugins", label: "Plugins", icon: Blocks, description: "" },
  { mode: "doctor", path: "/doctor", label: "Diagnostics", icon: HeartPulse, description: "" },
  { mode: "tools", path: "/tools", label: "Tools", icon: Wrench, description: "" },
  { mode: "launch", path: "/audits", label: "Workflows", icon: Rocket, description: "Plan reusable workflows and track their runs. Limits apply to the whole run." },
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

  if (mode === "plugins") {
    return <PageContent className="console-controls" aria-label="Plugins">
      <div ref={headingRef} tabIndex={-1} className="outline-none"><PageHeader title="Plugins" /></div>
      {content}
    </PageContent>;
  }

  if (mode === "launch") {
    return <PageContent className="console-controls" aria-label="Workflows"><PageHeader title="Workflows" summary={page.description || undefined} />{content}</PageContent>;
  }

  const focused = mode === "onboarding";

  return <PageContent className="console-controls">
    {!focused && <div ref={headingRef} tabIndex={-1} className="outline-none"><PageHeader title={mode === "settings" ? "Settings" : page.label} summary={page.description || undefined} actions={<Button asChild variant="ghost" size="sm"><Link to={returnTo}><ArrowLeft className="size-4" />Back to chat</Link></Button>} /></div>}
    {mode === "settings" && <nav aria-label="Account and diagnostics" className="flex flex-wrap gap-2">
      {[{ path: "/connections", label: "Connections", icon: KeyRound }, { path: "/models", label: "Models", icon: Sparkles }, { path: "/doctor", label: "Diagnostics", icon: HeartPulse }].map(item => <Button key={item.path} variant="outline" size="sm" asChild><Link to={`${item.path}${suffix}`}><item.icon className="size-4" />{item.label}</Link></Button>)}
    </nav>}
    <section className="min-w-0 space-y-6" aria-label={mode === "settings" ? "Preferences" : page.label}>
      {content}
      {mode === "doctor" && <div className="flex flex-wrap gap-2"><Button variant="outline" asChild><Link to={`/tools${suffix}`}><Wrench className="size-4" />Available tools</Link></Button><Button variant="outline" asChild><Link to={`/fix${suffix}`}><Wrench className="size-4" />Review a code fix</Link></Button></div>}
      {mode === "connections" && <Button variant="outline" asChild><Link to={`/project${suffix}`}><FolderCheck className="size-4" />Workspace settings</Link></Button>}
    </section>
  </PageContent>;
}
