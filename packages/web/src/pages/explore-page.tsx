import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Blocks } from "lucide-react";
import { CapyApiKeyIcon as ApiKey, CapyArrowUpRightIcon as ArrowRight, CapyBranchIcon as Branch, CapyChipIcon as Chip, CapyCheckIcon as Check, CapyDocumentIcon as Document, CapyGlobeIcon as Globe, CapyPresentationIcon as Presentation, CapyPuzzleIcon as Puzzle, CapySearchIcon as Search, CapySettingsIcon as Settings, CapySparkleFourIcon as SparkleFour, CapyTerminalSparkleIcon as Terminal } from "@/ui/icons/capy";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { PageContent } from "@/components/page-header";
import { LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBreadcrumbLabel } from "@/lib/breadcrumbs";
import { Feedback } from "@/components/console-control/control-ui";
import { useMcpServers } from "@/components/console-control/mcp-api";
import { PluginConfirmDialog, usePluginManager } from "@/components/console-control/plugin-manager";
import { ServiceIcon, useServicePlugins } from "@/components/console-control/service-plugins-control";
import { buildExploreEntries, exploreCategories, exploreSections, paginate, pluginPath, type ExploreEntry } from "@/components/console-control/plugin-detail-model";
import { YOURS, cleanSkillSummary, isBundledSkill, skillCategories, skillCategory, skillSections, withoutCatalogDuplicates, type BrowsableSkill } from "@/components/skills-model";
import { ThemesTab } from "@/components/explore/themes-tab";
import { Cell, Tile } from "@/components/explore/cells";
import { AddFromGithubSheet, AddedFromGithubChip, GithubSkillsSection, useSkillsCatalog } from "@/components/explore/skills-catalog";

const TABS = [
  { id: "plugins", label: "Plugins", title: "Plugins", search: "Search plugins" },
  { id: "skills", label: "Skills", title: "Skills", search: "Search skills" },
  { id: "themes", label: "Themes", title: "Themes", search: "Search themes" },
] as const;
const SECTION_PREVIEW = 6;

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  if (pages <= 1) return null;
  return <nav aria-label="Pagination" className="flex items-center justify-between text-sm text-muted-foreground-2"><Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button><span>{page} of {pages}</span><Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button></nav>;
}

function PluginsTab({ query, category, page, onCategories, onCategory, onPage }: { query: string; category: string; page: number; onCategories: (categories: Array<{ value: string; label: string }>) => void; onCategory: (category: string) => void; onPage: (page: number) => void }) {
  const manager = usePluginManager();
  const service = useServicePlugins();
  const mcp = useMcpServers();
  const { inventory, mutate } = manager;
  const loading = inventory.isPending || service.inventory.isPending;
  const unreachable = loading && (inventory.fetchStatus === "paused" || inventory.failureCount > 0 || service.inventory.fetchStatus === "paused" || service.inventory.failureCount > 0);
  const entries = buildExploreEntries({ plugins: inventory.data?.items ?? [], services: service.inventory.data?.items ?? [], mcp: mcp.servers });
  const categories = exploreCategories(entries);
  const flat = Boolean(query.trim() || category);
  const sections = exploreSections(entries, query, category);
  const registry = inventory.data?.registry;
  const categoryKey = categories.join("|");
  useEffect(() => { onCategories(categoryKey ? categoryKey.split("|").map(name => ({ value: name, label: name })) : []); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryKey]);
  const cell = (entry: ExploreEntry) => <Cell key={entry.key} to={pluginPath(entry.ref)} tile={<Tile logo={entry.logo} verified={entry.verified && entry.added} fallback={entry.ref.kind === "service" ? <ServiceIcon id={entry.ref.id} className="size-5" /> : <Blocks aria-hidden="true" className="size-5" />} />} name={entry.name} description={entry.description}
    trailing={entry.installable ? <Button variant="outline" size="sm" aria-label={`Add ${entry.name}`} disabled={mutate.isPending || !registry?.available} onClick={event => manager.requestConfirmation("install", inventory.data!.items.find(item => item.id === entry.ref.id)!, event.currentTarget)}>Add</Button>
      : entry.added ? <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground-1"><Check aria-hidden="true" className="size-(--icon-sm)" />Added</span> : undefined} />;
  const all = sections.flatMap(section => section.entries);
  const paged = paginate(all, page);
  return <div className="flex flex-col gap-8">
    {loading && !unreachable && <LoadingState label="Loading plugins…" variant="cards" />}
    {unreachable && <div role="status" className="flex flex-col items-start gap-3"><p className="text-sm text-muted-foreground-2">Reconnecting…</p><Button variant="outline" onClick={() => { void inventory.refetch(); void service.inventory.refetch(); }}>Try again</Button></div>}
    {inventory.error && <div className="flex flex-col items-start gap-3"><Feedback error={inventory.error} /><Button variant="outline" onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {registry?.error ? <Feedback error={registry.error} /> : registry && !registry.available && <Feedback error="The plugin registry is offline. Bundled connectors are still listed." />}
    <Feedback error={mutate.isError && !manager.confirmation ? mutate.error : null} message={manager.message} />
    {!loading && all.length === 0 && <p className="text-sm text-muted-foreground-2">{query.trim() ? "Nothing matches your search." : "No plugins are listed right now."}</p>}
    {flat && paged.rows.length > 0 && <><ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">{paged.rows.map(cell)}</ul><Pager page={paged.page} pages={paged.pages} onPage={onPage} /></>}
    {!flat && sections.map(section => <section key={section.category} aria-label={section.category} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4"><h2 className="text-sm font-medium text-foreground">{section.category}</h2>{section.entries.length > SECTION_PREVIEW && <Button variant="ghost" size="sm" onClick={() => onCategory(section.category)} aria-label={`View all ${section.category}`}>View all<ArrowRight aria-hidden="true" /></Button>}</div>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">{section.entries.slice(0, SECTION_PREVIEW).map(cell)}</ul>
    </section>)}
    <PluginConfirmDialog manager={manager} />
  </div>;
}

type SkillRow = BrowsableSkill & { origin?: unknown };
/** Per-category icon tile; categories without a dedicated Capy icon fall back to the document icon. */
const SKILL_ICON: Record<string, typeof Document> = { Web: Globe, Injection: Terminal, Identity: ApiKey, LLM: SparkleFour, "Native & crypto": Chip, "Code review": Branch, "Supply chain": Puzzle, Reporting: Presentation, Development: Settings };
const SCOPE: Record<string, string> = { workspace: "Project", personal: "Solo", project: "Project" };
function SkillsTab({ query, category, page, onCategories, onCategory, onPage }: { query: string; category: string; page: number; onCategories: (categories: Array<{ value: string; label: string }>) => void; onCategory: (category: string) => void; onPage: (page: number) => void }) {
  const { webFetchJson, client } = useBackendApi();
  const team = useTeamAccess();
  const inventory = useQuery({ queryKey: queryKeys.skills(client.backendId, team.user?.workspaceId, team.user?.userId), queryFn: ({ signal }) => webFetchJson<{ skills: SkillRow[] }>("/api/skills", { signal }), refetchInterval: 5000 });
  const { inventory: catalog } = useSkillsCatalog();
  const catalogNames = new Set(catalog.data?.skills.map(item => item.name) ?? []);
  const skills = withoutCatalogDuplicates(inventory.data?.skills ?? [], catalogNames);
  const options = skillCategories(skills);
  const optionKey = options.map(option => `${option.value}:${option.label}`).join("|");
  useEffect(() => { onCategories(options); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey]);
  const flat = Boolean(query.trim() || category);
  const sections = skillSections(skills, query, category);
  const all = sections.flatMap(section => section.skills);
  const paged = paginate(all, page);
  const cell = (skill: SkillRow, group?: string) => {
    const Icon = SKILL_ICON[skillCategory(skill)] ?? Document;
    const trailing = isBundledSkill(skill) ? (query.trim() && !category && group ? <span className="rounded-full bg-secondary/60 px-2 py-0.5 text-xs text-muted-foreground-2">{group}</span> : undefined)
      : skill.origin ? <AddedFromGithubChip />
      : <span className="text-xs text-muted-foreground-2">{skill.scope === "mounted" ? "Linked" : `Yours · ${SCOPE[skill.scope] ?? skill.scope}`}</span>;
    return <Cell key={skill.id} to={`/plugins/skills?skill=${encodeURIComponent(skill.id)}`} tile={<Tile fallback={<Icon aria-hidden="true" className="size-5" />} />} name={skill.name} description={cleanSkillSummary(skill)} trailing={trailing} />;
  };
  const groupOf = new Map(sections.flatMap(section => section.skills.map(skill => [skill.id, section.category] as const)));
  const yours = sections.find(section => section.category === YOURS);
  const builtIn = sections.filter(section => section.category !== YOURS);
  const builtInRows = builtIn.flatMap(section => section.skills);
  const pagedBuiltIn = paginate(flat ? all : builtInRows, page);
  const grid = (rows: SkillRow[]) => <ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">{rows.map(skill => cell(skill, query.trim() && !category ? groupOf.get(skill.id) : undefined))}</ul>;
  return <div className="flex flex-col gap-8">
    {!category && <GithubSkillsSection query={query} />}
    {inventory.isPending && !(inventory.fetchStatus === "paused" || inventory.failureCount > 0) && <LoadingState label="Loading skills…" variant="cards" />}
    {inventory.isPending && (inventory.fetchStatus === "paused" || inventory.failureCount > 0) && <div role="status" className="flex flex-col items-start gap-3"><p className="text-sm text-muted-foreground-2">Reconnecting…</p><Button variant="outline" onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {inventory.error && <div className="flex flex-col items-start gap-3"><Feedback error={inventory.error} /><Button variant="outline" onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {inventory.data && (category || query.trim()) && all.length === 0 && <p className="text-sm text-muted-foreground-2">Nothing matches your search.</p>}
    {flat && pagedBuiltIn.rows.length > 0 && <section aria-label={category ? "Skills" : "Included"} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">{category ? sections[0]?.category ?? "Skills" : "Included"}</h2>
      {grid(pagedBuiltIn.rows)}<Pager page={pagedBuiltIn.page} pages={pagedBuiltIn.pages} onPage={onPage} />
    </section>}
    {!flat && builtIn.length > 0 && <section aria-label="Included" className="flex flex-col gap-6">
      <h2 className="text-sm font-medium text-foreground">Included</h2>
      {builtIn.map(section => <section key={section.slug} aria-label={section.category} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4"><h3 className="text-sm text-muted-foreground-1">{section.category}</h3>{section.skills.length > SECTION_PREVIEW && <Button variant="ghost" size="sm" onClick={() => onCategory(section.slug)} aria-label={`View all ${section.category}`}>View all<ArrowRight aria-hidden="true" /></Button>}</div>
        <ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">{section.skills.slice(0, SECTION_PREVIEW).map(skill => cell(skill))}</ul>
      </section>)}
    </section>}
    {!flat && yours && <section aria-label="Your skills" className="flex flex-col gap-3"><h2 className="text-sm font-medium text-foreground">Your skills</h2>{grid(yours.skills)}</section>}
    <Button variant="outline" size="sm" className="self-start" render={<Link to="/plugins/skills" />}>Open installed skills</Button>
  </div>;
}

/** Explore: plugins, skills and themes behind one search box and three tabs. The tab, category and page live in the URL. */
export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find(item => item.id === params.get("tab"))?.id ?? "plugins";
  const current = TABS.find(item => item.id === tab)!;
  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);
  const rawCategory = params.get("category") ?? "";
  // A stale category from an old link falls back to all once the real categories are known.
  const category = categories.length > 0 && !categories.some(option => option.value === rawCategory) ? "" : rawCategory;
  const page = Number(params.get("page")) || 1;
  const query = params.get("q") ?? "";
  const [addOpen, setAddOpen] = useState(false);
  /** Tab and category changes are history entries so Back returns to the previous view; typing and paging replace. */
  const update = (next: Record<string, string | null>, replace = false) => setParams(previous => { const copy = new URLSearchParams(previous); for (const [key, value] of Object.entries(next)) { if (value) copy.set(key, value); else copy.delete(key); } return copy; }, { replace });
  return <PageContent>
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <h1 className="min-w-0 text-xl font-medium text-foreground">Explore</h1>
      <div className="relative w-full sm:w-64"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-(--icon-sm) -translate-y-1/2 text-muted-foreground-2" /><Input type="search" aria-label={current.search} className="pl-9" placeholder={current.search} autoComplete="off" data-1p-ignore data-lpignore="true" value={query} onChange={event => update({ q: event.target.value || null, page: null }, true)} /></div>
    </header>
    <div className="-mt-6 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <Tabs value={tab} onValueChange={value => { setCategories([]); update({ tab: value === "plugins" ? null : String(value), category: null, page: null, q: null }); }}>
        <TabsList variant="line" aria-label="Explore sections">{TABS.map(item => <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>)}</TabsList>
      </Tabs>
      <div className="flex shrink-0 items-center gap-2">
      {tab === "skills" && <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>Add from GitHub</Button>}
      {tab !== "themes" && categories.length > 0 && <Select aria-label="Categories" size="sm" className="w-36 shrink-0 sm:w-40" value={category} onValueChange={value => update({ category: value || null, page: null })} options={[{ value: "", label: "All categories" }, ...categories]} />}
      </div>
    </div>
    {tab === "plugins" && <PluginsTab query={query} category={category} page={page} onCategories={setCategories} onCategory={name => update({ category: name, page: null })} onPage={value => update({ page: String(value) }, true)} />}
    {tab === "skills" && <SkillsTab query={query} category={category} page={page} onCategories={setCategories} onCategory={name => update({ category: name, page: null })} onPage={value => update({ page: String(value) }, true)} />}
    {tab === "themes" && <ThemesTab query={query} />}
    <AddFromGithubSheet open={addOpen} onOpenChange={setAddOpen} />
  </PageContent>;
}
