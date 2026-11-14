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
import { EntryLogo } from "@/components/console-control/mcp-ui";
import { Feedback } from "@/components/console-control/control-ui";
import { useMcpServers } from "@/components/console-control/mcp-api";
import { PluginConfirmDialog, usePluginManager } from "@/components/console-control/plugin-manager";
import { ServiceIcon, useServicePlugins } from "@/components/console-control/service-plugins-control";
import { buildExploreEntries, exploreCategories, exploreSections, paginate, pluginPath, type ExploreEntry } from "@/components/console-control/plugin-detail-model";
import { cleanSkillSummary, isBuiltinSkill, skillCategories, skillCategory, skillSections, type BrowsableSkill } from "@/components/skills-model";
import { ThemesTab } from "@/components/explore/themes-tab";

const TABS = [
  { id: "plugins", label: "Plugins", title: "Plugins", subtitle: "Extend what 0 can do with your tools", search: "Search plugins" },
  { id: "skills", label: "Skills", title: "Skills", subtitle: "Reusable instructions 0 follows when they apply", search: "Search skills" },
  { id: "themes", label: "Themes", title: "Themes", subtitle: "Palettes for light and dark", search: "Search themes" },
] as const;
const SECTION_PREVIEW = 6;

/** 40px logo tile with the small verified check at its corner. The check only appears when the registry or a built-in connector vouches for the entry. */
function Tile({ logo, verified, fallback }: { logo?: string; verified?: boolean; fallback: ReactNode }) {
  return <span className="relative shrink-0"><EntryLogo logo={logo} className="size-10 rounded-lg" fallback={fallback} />{verified && <span role="img" aria-label="Verified" className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-foreground text-background ring-2 ring-background"><Check aria-hidden="true" className="size-2.5" /></span>}</span>;
}

/** One compact grid cell: tile, name and a single truncated line. The whole cell is a link; an action sits above it. */
function Cell({ to, logo, verified, icon, name, description, trailing }: { to: string; logo?: string; verified?: boolean; icon: ReactNode; name: string; description: string; trailing?: ReactNode }) {
  return <li className="relative flex min-w-0 items-center gap-3 rounded-(--radius-card) p-2 hover:bg-secondary/40 focus-within:bg-secondary/40">
    <Tile logo={logo} verified={verified} fallback={icon} />
    <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-foreground"><Link to={to} className="outline-none after:absolute after:inset-0 focus-visible:after:outline-ring-inset focus-visible:after:outline-2">{name}</Link></h3><p className="truncate text-sm text-muted-foreground-2">{description}</p></div>
    {trailing && <span className="relative z-10 shrink-0">{trailing}</span>}
  </li>;
}

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
  const entries = buildExploreEntries({ plugins: inventory.data?.items ?? [], services: service.inventory.data?.items ?? [], mcp: mcp.servers });
  const categories = exploreCategories(entries);
  const flat = Boolean(query.trim() || category);
  const sections = exploreSections(entries, query, category);
  const registry = inventory.data?.registry;
  const categoryKey = categories.join("|");
  useEffect(() => { onCategories(categoryKey ? categoryKey.split("|").map(name => ({ value: name, label: name })) : []); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryKey]);
  const cell = (entry: ExploreEntry) => <Cell key={entry.key} to={pluginPath(entry.ref)} logo={entry.logo} verified={entry.verified} icon={entry.ref.kind === "service" ? <ServiceIcon id={entry.ref.id} className="size-5" /> : <Blocks aria-hidden="true" className="size-5" />} name={entry.name} description={entry.description}
    trailing={entry.installable ? <Button variant="outline" size="sm" aria-label={`Add ${entry.name}`} disabled={mutate.isPending || !registry?.available} onClick={event => manager.requestConfirmation("install", inventory.data!.items.find(item => item.id === entry.ref.id)!, event.currentTarget)}>Add</Button>
      : entry.added ? <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground-1"><Check aria-hidden="true" className="size-(--icon-sm)" />Added</span> : undefined} />;
  const all = sections.flatMap(section => section.entries);
  const paged = paginate(all, page);
  return <div className="flex flex-col gap-8">
    {loading && <LoadingState label="Loading plugins…" variant="cards" />}
    {inventory.error && <div className="flex flex-col items-start gap-3"><Feedback error={inventory.error} /><Button variant="outline" onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {registry?.error ? <Feedback error={registry.error} /> : registry && !registry.available && <Feedback error="The plugin registry is offline. Built-in connectors are still listed." />}
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

type SkillRow = BrowsableSkill;
/** Per-category icon tile; categories without a dedicated Capy icon fall back to the document icon. */
const SKILL_ICON: Record<string, typeof Document> = { Web: Globe, Injection: Terminal, Identity: ApiKey, LLM: SparkleFour, "Native & crypto": Chip, "Code review": Branch, "Supply chain": Puzzle, Reporting: Presentation, Development: Settings };
const SCOPE: Record<string, string> = { workspace: "Workspace", personal: "Solo", project: "Project" };
function SkillsTab({ query, category, page, onCategories, onCategory, onPage }: { query: string; category: string; page: number; onCategories: (categories: Array<{ value: string; label: string }>) => void; onCategory: (category: string) => void; onPage: (page: number) => void }) {
  const { webFetchJson, client } = useBackendApi();
  const team = useTeamAccess();
  const inventory = useQuery({ queryKey: queryKeys.skills(client.backendId, team.user?.workspaceId, team.user?.userId), queryFn: ({ signal }) => webFetchJson<{ skills: SkillRow[] }>("/api/skills", { signal }), refetchInterval: 5000 });
  const skills = inventory.data?.skills ?? [];
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
    const trailing = isBuiltinSkill(skill) ? (query.trim() && !category && group ? <span className="rounded-full bg-secondary/60 px-2 py-0.5 text-xs text-muted-foreground-2">{group}</span> : undefined)
      : <span className="text-xs text-muted-foreground-2">{skill.scope === "mounted" ? "Mounted" : `Yours · ${SCOPE[skill.scope] ?? skill.scope}`}</span>;
    return <Cell key={skill.id} to={`/plugins/skills?skill=${encodeURIComponent(skill.id)}`} icon={<Icon aria-hidden="true" className="size-5" />} name={skill.name} description={cleanSkillSummary(skill)} trailing={trailing} />;
  };
  const groupOf = new Map(sections.flatMap(section => section.skills.map(skill => [skill.id, section.category] as const)));
  return <div className="flex flex-col gap-8">
    {inventory.isPending && <LoadingState label="Loading skills…" variant="cards" />}
    {inventory.error && <div className="flex flex-col items-start gap-3"><Feedback error={inventory.error} /><Button variant="outline" onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {inventory.data && all.length === 0 && <p className="text-sm text-muted-foreground-2">{query.trim() ? "Nothing matches your search." : "No skills yet."}</p>}
    {flat && paged.rows.length > 0 && <><ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">{paged.rows.map(skill => cell(skill, groupOf.get(skill.id)))}</ul><Pager page={paged.page} pages={paged.pages} onPage={onPage} /></>}
    {!flat && sections.map(section => <section key={section.slug} aria-label={section.category} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4"><h2 className="text-sm font-medium text-foreground">{section.category}</h2>{section.skills.length > SECTION_PREVIEW && <Button variant="ghost" size="sm" onClick={() => onCategory(section.slug)} aria-label={`View all ${section.category}`}>View all<ArrowRight aria-hidden="true" /></Button>}</div>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">{section.skills.slice(0, SECTION_PREVIEW).map(skill => cell(skill))}</ul>
    </section>)}
    <Button variant="outline" size="sm" className="self-start" render={<Link to="/plugins/skills" />}>Open the skills editor</Button>
  </div>;
}

/** Explore: plugins, skills and themes behind one search box and three tabs. The tab, category and page live in the URL. */
export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find(item => item.id === params.get("tab"))?.id ?? "plugins";
  const current = TABS.find(item => item.id === tab)!;
  const category = params.get("category") ?? "";
  const page = Number(params.get("page")) || 1;
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);
  const update = (next: Record<string, string | null>) => setParams(previous => { const copy = new URLSearchParams(previous); for (const [key, value] of Object.entries(next)) { if (value) copy.set(key, value); else copy.delete(key); } return copy; }, { replace: true });
  return <PageContent>
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1"><h1 className="text-xl font-medium text-foreground">{current.title}</h1><p className="text-sm text-muted-foreground-2">{current.subtitle}</p></div>
      <div className="relative w-full sm:w-64"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-(--icon-sm) -translate-y-1/2 text-muted-foreground-2" /><Input type="search" aria-label={current.search} className="pl-9" placeholder={current.search} autoComplete="off" data-1p-ignore data-lpignore="true" value={query} onChange={event => { setQuery(event.target.value); update({ page: null }); }} /></div>
    </header>
    <div className="-mt-6 flex min-w-0 items-center justify-between gap-4">
      <Tabs value={tab} onValueChange={value => { setQuery(""); setCategories([]); update({ tab: value === "plugins" ? null : String(value), category: null, page: null }); }}>
        <TabsList variant="line" aria-label="Explore sections">{TABS.map(item => <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>)}</TabsList>
      </Tabs>
      {tab !== "themes" && categories.length > 0 && <Select aria-label="Categories" size="sm" className="w-32 shrink-0 sm:w-40" value={category} onValueChange={value => update({ category: value || null, page: null })} options={[{ value: "", label: "All categories" }, ...categories]} />}
    </div>
    {tab === "plugins" && <PluginsTab query={query} category={category} page={page} onCategories={setCategories} onCategory={name => update({ category: name, page: null })} onPage={value => update({ page: String(value) })} />}
    {tab === "skills" && <SkillsTab query={query} category={category} page={page} onCategories={setCategories} onCategory={name => update({ category: name, page: null })} onPage={value => update({ page: String(value) })} />}
    {tab === "themes" && <ThemesTab query={query} />}
  </PageContent>;
}
