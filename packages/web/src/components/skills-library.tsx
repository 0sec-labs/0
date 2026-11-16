import { v } from "@/lib/vocabulary";
import type { ReactNode } from "react";
import { Star } from "lucide-react";
import { CapyAutomationsIcon, CapyBranchIcon, CapyChipIcon, CapyCloudIcon, CapyDocumentIcon, CapyGlobeIcon, CapyApiKeyIcon, CapyPresentationIcon, CapyPuzzleIcon, CapyRepositoriesIcon, CapyShieldIcon, CapySparkleIcon, CapyTerminalSparkleIcon, CapyFolderPlusIcon } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, LoadingState } from "@/components/state-panel";
import { Cell, Tile } from "@/components/skills/cells";
import { useSkillsCatalog } from "@/components/skills/skills-catalog";
import { abbreviateStars, VERIFIED_BY_0, VERIFIED_HINT, type CatalogPublisher, type CatalogSkill } from "@/components/skills/skills-catalog-model";
import { cleanSkillSummary } from "@/components/skills-model";
import { installedSource, installedTile, isFirstParty, rankInstalled, type InstalledSkill } from "@/lib/installed-skills";
import type { SkillIconKey } from "@/lib/skill-icons";

export type SkillLibraryItem = InstalledSkill & {
  scope: string;
  revision: string;
  writable: boolean;
  fileCount: number;
};

const ICONS: Record<SkillIconKey, typeof CapyDocumentIcon> = {
  web: CapyGlobeIcon, injection: CapyTerminalSparkleIcon, identity: CapyApiKeyIcon, llm: CapySparkleIcon, native: CapyChipIcon, crypto: CapyShieldIcon,
  source: CapyRepositoriesIcon, cloud: CapyCloudIcon, supply: CapyPuzzleIcon, ci: CapyAutomationsIcon, report: CapyPresentationIcon, develop: CapyBranchIcon,
  extension: CapyPuzzleIcon, folder: CapyFolderPlusIcon, document: CapyDocumentIcon,
};

function InstalledRow({ skill, shared, publishers, catalog, onSelect }: { skill: SkillLibraryItem; shared: boolean; publishers: Record<string, CatalogPublisher>; catalog: ReadonlyMap<string, CatalogSkill>; onSelect: (id: string) => void }) {
  const tile = installedTile(skill);
  const publisher = tile.kind === "publisher" ? publishers[tile.owner] : undefined;
  const stars = skill.origin?.catalogId ? catalog.get(skill.origin.catalogId)?.stars : undefined;
  const first = isFirstParty(skill);
  const Icon = tile.kind === "icon" ? ICONS[tile.icon] : CapyDocumentIcon;
  const visual = tile.kind === "publisher" ? <Tile avatar={publisher?.avatar ?? ""} name={publisher?.name ?? tile.name} />
    : tile.kind === "icon" ? <Tile icon={<Icon aria-hidden="true" className="size-4 text-muted-foreground-1" />} verified={first} verifiedLabel={VERIFIED_BY_0} verifiedHint={VERIFIED_HINT} />
    : <Tile avatar="" name={tile.name} />;
  return <Cell to={`/skills?skill=${encodeURIComponent(skill.id)}`} onOpen={() => onSelect(skill.id)} interactive={false} name={skill.name} description={cleanSkillSummary(skill)} tile={visual}
    trailing={<span className="flex max-w-40 flex-col items-end gap-0.5 text-sm">
      {stars !== undefined && <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground-1"><Star aria-hidden="true" className="size-3.5" /><span>{abbreviateStars(stars)}</span></span>}
      <span className="max-w-full truncate text-muted-foreground-2" title={skill.origin ? `${skill.origin.repo} at ${skill.origin.sha.slice(0, 12)}` : undefined}>{installedSource(skill, shared)}</span>
    </span>} />;
}

/** Skills page body. Installed is a flat ranked list (yours, built-in, extension) in the same Cell as Browse; Browse is passed in. The search lives in the page header. */
export function SkillsLibrary({ skills, loading, error, onSelect, disabled = false, shared = false, onRetry, tab = "installed", onTab, browse, query = "" }: {
  tab?: "installed" | "browse";
  onTab?: (tab: "installed" | "browse") => void;
  browse?: ReactNode;
  query?: string;
  skills: SkillLibraryItem[];
  loading: boolean;
  error?: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  shared?: boolean;
  onRetry?: () => void;
}) {
  const { inventory } = useSkillsCatalog();
  const publishers = inventory.data?.publishers ?? {};
  const catalog = new Map((inventory.data?.skills ?? []).map(skill => [skill.id, skill] as const));
  const rows = rankInstalled(skills, query, shared);
  const content = loading && !skills.length ? <LoadingState label="Loading skills…" />
    : error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-menu)] bg-destructive/10 p-4 text-sm"><p className="text-destructive">{error}</p>{onRetry && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>Try again</Button>}</div>
      : rows.length ? <ul aria-label="Installed skills" className="grid grid-cols-1 gap-x-12 gap-y-4 md:grid-cols-2">{rows.map(skill => <InstalledRow key={skill.id} skill={skill} shared={shared} publishers={publishers} catalog={catalog} onSelect={onSelect} />)}</ul>
      : <EmptyState variant="inline" title={query.trim() ? "No matching skills." : v("No installed skills yet.")} />;
  return <Tabs value={tab} onValueChange={value => onTab?.(value === "browse" ? "browse" : "installed")} className="gap-6">
    <TabsList variant="line" aria-label="Skill collection"><TabsTrigger value="installed">Installed</TabsTrigger><TabsTrigger value="browse">Browse</TabsTrigger></TabsList>
    <TabsContent value="installed">{content}</TabsContent>
    <TabsContent value="browse">{browse}</TabsContent>
  </Tabs>;
}
