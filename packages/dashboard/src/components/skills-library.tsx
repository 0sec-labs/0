import { useState } from "react";
import { ArrowUpRight, BookOpen, FileText, Plus, Search } from "lucide-react";
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
      : visible.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map(skill => <Button key={skill.id} type="button" variant="ghost" disabled={disabled} onClick={() => onSelect(skill.id)} aria-label={`Open skill ${skill.name}`} className="group h-auto min-h-44 w-full flex-col items-start justify-start gap-3 whitespace-normal rounded-[var(--radius-panel)] bg-muted/35 p-5 text-left font-normal transition-colors hover:bg-muted/50">
          <span className="flex w-full items-center justify-between gap-3"><BookOpen aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" /><ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /></span>
          <span className="block w-full truncate text-sm font-medium" title={skill.name}>{skill.name}</span>
          <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description || "Reusable instructions for the agent."}</span>
          <span className="mt-auto flex w-full items-center justify-between gap-3 pt-2 text-xs text-muted-foreground"><span>{scopeLabel(skill.scope, shared)}</span><span className="flex shrink-0 items-center gap-1.5"><FileText aria-hidden="true" className="size-3.5" />{skill.fileCount} {skill.fileCount === 1 ? "file" : "files"}</span></span>
        </Button>)}
      </div> : <div className="flex flex-col items-center gap-3 py-14 text-center">
        <BookOpen aria-hidden="true" className="size-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{needle ? "No matching skills." : tab === "builtin" ? "No built-in skills available." : "No installed skills yet."}</p>
        {!needle && tab === "installed" && <><p className="max-w-sm text-xs leading-5 text-muted-foreground">Create instructions in chat, or start by customizing a built-in skill.</p><div className="flex flex-wrap justify-center gap-2">{canCreate && <Button type="button" size="sm" disabled={disabled} onClick={onCreate}><Plus aria-hidden="true" className="size-4" />New skill</Button>}<Button type="button" size="sm" variant="ghost" onClick={() => setTab("builtin")}>Browse built-in skills</Button></div></>}
      </div>;
  return <Tabs value={tab} onValueChange={setTab} className="gap-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <TabsList aria-label="Skill collection"><TabsTrigger value="installed">Installed</TabsTrigger><TabsTrigger value="builtin">Built in</TabsTrigger></TabsList>
      <div className="relative w-full sm:w-72"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input type="search" aria-label="Search skills" placeholder="Search skills…" value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></div>
    </div>
    <TabsContent value="installed">{tab === "installed" && content}</TabsContent>
    <TabsContent value="builtin">{tab === "builtin" && content}</TabsContent>
  </Tabs>;
}
