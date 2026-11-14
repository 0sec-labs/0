import { v } from "@/lib/vocabulary";
import { useState } from "react";
import { CapyDocumentIcon as BookOpen, CapyDocumentIcon as FileText, CapySearchIcon as Search } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingState } from "@/components/state-panel";

export type SkillLibraryItem = {
  id: string;
  name: string;
  description: string;
  scope: string;
  revision: string;
  writable: boolean;
  fileCount: number;
  source: string;
};

const scopeLabel = (scope: string, shared: boolean) => ({
  builtin: "Built in",
  workspace: shared ? "Team" : "Workspace",
  personal: "Solo",
  project: "Project",
  mounted: "Mounted",
})[scope] ?? scope;

/** Inventory stays compact; the selected skill opens in the chat editor. */
export function SkillsLibrary({ skills, loading, error, onSelect, onCreate, disabled = false, shared = false, canCreate = true, onRetry }: {
  skills: SkillLibraryItem[];
  loading: boolean;
  error?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  disabled?: boolean;
  shared?: boolean;
  canCreate?: boolean;
  onRetry?: () => void;
}) {
  const [tab, setTab] = useState("installed");
  const [search, setSearch] = useState("");
  const needle = search.trim().toLocaleLowerCase();
  const visible = skills.filter(skill => (tab === "builtin" ? skill.scope === "builtin" : skill.scope !== "builtin")
    && `${skill.name} ${skill.description} ${skill.scope} ${scopeLabel(skill.scope, shared)}`.toLocaleLowerCase().includes(needle));
  const content = loading && !skills.length ? <LoadingState label="Loading skills…" variant="cards" />
    : error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-menu)] bg-destructive/10 p-4 text-sm"><p className="text-destructive">{error}</p>{onRetry && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>Try again</Button>}</div>
      : visible.length ? <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-panel,16px)] border border-border">
        {visible.map(skill => <li key={skill.id}><button type="button" disabled={disabled} onClick={() => onSelect(skill.id)} aria-label={`Open skill ${skill.name}`} className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:opacity-50">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block truncate font-medium" title={skill.name}>{skill.name}</span><span className="block truncate text-xs text-muted-foreground">{skill.description || "Reusable instructions for the agent."}</span></span>
          <span className="shrink-0 text-xs text-muted-foreground">{scopeLabel(skill.scope, shared)}</span>
        </button></li>)}
      </ul> : <div className="flex flex-col items-center gap-3 py-14 text-center">
        <BookOpen aria-hidden="true" className="size-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{needle ? "No matching skills." : tab === "builtin" ? "No built-in skills available." : v("No installed skills yet. Create one from {a mission}, or customize a built-in skill.")}</p>
        {!needle && tab === "installed" && <Button type="button" size="sm" variant="outline" onClick={() => setTab("builtin")}>Browse built-in skills</Button>}
      </div>;
  return <Tabs value={tab} onValueChange={setTab} className="gap-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <TabsList aria-label="Skill collection"><TabsTrigger value="installed">Installed</TabsTrigger><TabsTrigger value="builtin">Built in</TabsTrigger></TabsList>
      <div className="relative w-full sm:w-72"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input type="search" aria-label="Search skills" placeholder="Search skills…" value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></div>
    </div>
    <TabsContent value="installed">{tab === "installed" && content}</TabsContent>
    <TabsContent value="builtin">{tab === "builtin" && content}</TabsContent>
  </Tabs>;
}
