import { v } from "@/lib/vocabulary";
import { useState, type ReactNode } from "react";
import { CapyDocumentIcon as BookOpen, CapyDocumentIcon as FileText, CapySearchIcon as Search } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingState } from "@/components/state-panel";
import { cleanSkillSummary, isBundledSkill, skillSections } from "@/components/skills-model";

export type SkillLibraryItem = {
  id: string;
  name: string;
  description: string;
  scope: string;
  revision: string;
  writable: boolean;
  fileCount: number;
  source: string;
  summary?: string;
  category?: string;
  internal?: boolean;
  /** Present when the skill was added from GitHub: repo, path, pinned commit and licence. */
  origin?: { repo: string; sha: string };
};

const scopeLabel = (scope: string, shared: boolean) => ({
  workspace: shared ? "Team" : "Folder",
  personal: "Solo",
  project: "Folder",
  mounted: "Linked",
})[scope] ?? "";

/** Skills page body: Installed (yours first, then the ones that come with 0, grouped by topic) and Browse (the GitHub directory, passed in as `browse`). */
export function SkillsLibrary({ skills, loading, error, onSelect, onCreate, disabled = false, shared = false, canCreate = true, onRetry, tab = "installed", onTab, browse }: {
  tab?: "installed" | "browse";
  onTab?: (tab: "installed" | "browse") => void;
  browse?: ReactNode;
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
  const [search, setSearch] = useState("");
  const sections = skillSections(skills, search);
  const trailing = (skill: SkillLibraryItem) => isBundledSkill(skill) ? "" : skill.origin ? "From GitHub" : scopeLabel(skill.scope, shared);
  const row = (skill: SkillLibraryItem) => <li key={skill.id}><button type="button" disabled={disabled} onClick={() => onSelect(skill.id)} aria-label={`Open skill ${skill.name}`} title={skill.origin ? `${skill.origin.repo} at ${skill.origin.sha.slice(0, 12)}` : undefined} className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted/50 focus-visible:outline-ring-inset disabled:opacity-50">
    <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1"><span className="block truncate font-medium" title={skill.name}>{skill.name}</span><span className="block truncate text-xs text-muted-foreground">{cleanSkillSummary(skill)}</span></span>
    <span className="shrink-0 text-xs text-muted-foreground">{trailing(skill)}</span>
  </button></li>;
  const content = loading && !skills.length ? <LoadingState label="Loading skills…" variant="cards" />
    : error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-menu)] bg-destructive/10 p-4 text-sm"><p className="text-destructive">{error}</p>{onRetry && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>Try again</Button>}</div>
      : sections.length ? <div className="flex flex-col gap-6">{sections.map(section => <section key={section.slug} aria-label={section.category} className="flex flex-col gap-1">
        <h2 className="px-3 pb-1 text-sm font-medium text-foreground">{section.category}</h2>
        <ul className="flex flex-col">{section.skills.map(row)}</ul>
      </section>)}</div> : <div className="flex flex-col items-center gap-3 py-14 text-center">
        <BookOpen aria-hidden="true" className="size-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{search.trim() ? "No matching skills." : v("No installed skills yet.")}</p>
        {!search.trim() && <Button type="button" size="sm" variant="outline" onClick={() => onTab?.("browse")}>Browse skills</Button>}
        {!search.trim() && canCreate && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCreate}>New skill</Button>}
      </div>;
  return <Tabs value={tab} onValueChange={value => onTab?.(value === "browse" ? "browse" : "installed")} className="gap-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <TabsList variant="line" aria-label="Skill collection"><TabsTrigger value="installed">Installed</TabsTrigger><TabsTrigger value="browse">Browse</TabsTrigger></TabsList>
      {tab === "installed" && <div className="relative w-full sm:w-72"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input type="search" aria-label="Search skills" placeholder="Search installed skills…" value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></div>}
    </div>
    <TabsContent value="installed">{content}</TabsContent>
    <TabsContent value="browse">{browse}</TabsContent>
  </Tabs>;
}
