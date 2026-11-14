import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { CapyArrowUpRightIcon as ArrowUpRight, CapyCheckIcon as Check, CapyMoreIcon as More } from "@/ui/icons/capy";
import { PageContent } from "@/components/page-header";
import { EmptyState, LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusBadge } from "@/ui/components/status-badge";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { SettingsCard, SettingsCardRow } from "@/ui/components/settings-card";
import { Feedback } from "@/components/console-control/control-ui";
import { CardHeaderRow } from "@/components/console-control/connection-ui";
import { useBreadcrumbLabel } from "@/lib/breadcrumbs";
import { AddSkillDialog, CatalogTile, SkillMarkdown, useSkillsCatalog, usePreview } from "@/components/explore/skills-catalog";
import { abbreviateStars, githubCommitUrl, githubTreeUrl, VERIFIED_BY_0, VERIFIED_HINT } from "@/components/explore/skills-catalog-model";

function RailFact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1"><dt className="text-sm text-muted-foreground-2">{label}</dt><dd className="min-w-0 text-sm break-words text-foreground">{children}</dd></div>;
}
const External = ({ href, children, mono = false }: { href: string; children: ReactNode; mono?: boolean }) => <a href={href} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 underline-offset-4 hover:underline${mono ? " font-mono text-xs" : ""}`}>{children}<ArrowUpRight aria-hidden="true" className="size-(--icon-sm) text-muted-foreground-2" /></a>;
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

/** A catalog skill: header with the same tile and verified check as the list, the real pinned SKILL.md, and one explicit Add. */
export function SkillCatalogDetailPage() {
  const { id = "" } = useParams();
  const { inventory, install, remove, canWrite } = useSkillsCatalog();
  const skill = inventory.data?.skills.find(item => item.id === id);
  const publisher = skill ? inventory.data?.publishers[skill.publisher] : undefined;
  const preview = usePreview(skill ? { id: skill.id } : null);
  const [dialog, setDialog] = useState<"add" | "remove" | null>(null);
  useBreadcrumbLabel(skill?.title);

  if (inventory.isPending) return <PageContent width="wide"><LoadingState label="Loading skill…" variant="cards" /></PageContent>;
  if (!skill || !inventory.data) return <PageContent><EmptyState title="Skill not found" body="It is not listed in the skills directory, or the link is out of date." action={<Button variant="outline" render={<Link to="/plugins/explore?tab=skills" />}>Back to skills</Button>} /></PageContent>;

  const data = preview.data;
  const installed = skill.installed;
  const close = () => { setDialog(null); install.reset(); remove.reset(); };
  const source = githubTreeUrl(skill.repo, skill.commit, skill.path);
  const primary = installed ? <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground-1"><Check aria-hidden="true" className="size-(--icon-sm)" />Added</span>
    : !skill.installable ? <Button variant="outline" render={<a href={source} target="_blank" rel="noopener noreferrer" />}>View on GitHub<ArrowUpRight aria-hidden="true" /></Button>
    : preview.error ? null : <Button variant="inverse" disabled={!canWrite || !data} onClick={() => { install.reset(); setDialog("add"); }}>Add</Button>;
  return <PageContent width="wide" className="gap-0">
    <div className="grid min-w-0 grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="flex min-w-0 flex-col gap-8" aria-label={skill.title}>
        <header className="flex min-w-0 flex-col gap-4">
          <div className="w-fit"><CatalogTile skill={skill} publisher={publisher} size="lg" /></div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3"><h1 className="text-2xl font-medium tracking-tight break-words text-foreground">{skill.title}</h1><span className="text-sm text-muted-foreground-2">Skill</span></div>
            <div className="flex shrink-0 items-center gap-2">
              {primary}
              {installed && canWrite && <DropdownMenu>
                <DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`More actions for ${skill.title}`} />}><More /></DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" sideOffset={4}><DropdownMenu.Item variant="danger" onClick={() => { remove.reset(); setDialog("remove"); }}>Remove</DropdownMenu.Item></DropdownMenu.Content>
              </DropdownMenu>}
            </div>
          </div>
          <p className="text-base text-muted-foreground-1">{skill.summary}</p>
          {!skill.installable && <p className="text-sm text-muted-foreground-2">{data?.licence.notice ?? "No open licence is declared, so 0 links to the original instead of copying it."}</p>}
          {!canWrite && <p className="text-sm text-muted-foreground-2">Viewers cannot add skills.</p>}
        </header>
        <section aria-label="SKILL.md" className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">SKILL.md <span className="font-normal text-muted-foreground-2">at {skill.commit.slice(0, 7)}</span></h2>
          {preview.isPending && <LoadingState label="Reading SKILL.md from GitHub…" variant="cards" />}
          {preview.error && <div className="flex flex-col items-start gap-3"><p role="alert" className="text-sm text-muted-foreground-1">{preview.error instanceof Error && preview.error.message ? preview.error.message : "Couldn't load the preview."}</p><Button variant="outline" size="sm" aria-busy={preview.isFetching || undefined} disabled={preview.isFetching} onClick={() => void preview.refetch()}>{preview.isFetching ? "Retrying…" : "Retry"}</Button></div>}
          {data && <>
            {data.warnings.length > 0 && <ul aria-label="Review notes" className="flex flex-col gap-1 text-sm text-muted-foreground-1">{data.warnings.map(item => <li key={item}>{item}</li>)}</ul>}
            <div className="min-w-0 rounded-(--radius-card) border-[0.5px] border-border-2 p-4"><SkillMarkdown text={data.skillMd.text} /></div>
            {data.skillMd.truncated && <p className="text-sm text-muted-foreground-2">Showing the first 64 KiB of SKILL.md.</p>}
          </>}
        </section>
        {data && data.files.length > 1 && <SettingsCard className="mx-0" aria-label="Files">
          <CardHeaderRow title={`${data.files.length} files`} />
          {data.files.map(file => <SettingsCardRow key={file.path} className="justify-between gap-4"><span className="min-w-0 truncate font-mono text-xs text-foreground">{file.path}</span><span className="shrink-0 text-xs text-muted-foreground-2">{/^scripts\/|\.(sh|py|js|mjs|ts|rb|ps1|bat)$/.test(file.path) ? "Script, never run by 0 · " : ""}{size(file.size)}</span></SettingsCardRow>)}
        </SettingsCard>}
        <Feedback error={remove.isError && dialog === null ? remove.error : null} />
      </article>
      <aside aria-label="Skill details" className="flex min-w-0 flex-col gap-6 border-t-[0.5px] border-border-2 pt-8 lg:border-t-0 lg:pt-1">
        {skill.verified && <Tooltip content={VERIFIED_HINT}><span className="w-fit"><StatusBadge appearance="outline" icon={<Check aria-hidden="true" className="size-3" />}>{VERIFIED_BY_0}</StatusBadge></span></Tooltip>}
        <dl className="flex flex-col gap-5">
          <RailFact label="Made by"><External href={publisher?.url ?? `https://github.com/${skill.publisher}`}>{publisher?.name ?? skill.publisher}</External></RailFact>
          <RailFact label="Repository"><External href={`https://github.com/${skill.repo}`}>{skill.repo}</External></RailFact>
          <RailFact label="GitHub stars"><span className="tabular-nums" title={`${skill.stars.toLocaleString("en-US")} stars`}>{abbreviateStars(skill.stars)}</span> <span className="text-muted-foreground-2">checked {new Date(inventory.data.generated).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span></RailFact>
          <RailFact label="Licence">{skill.licence ?? "None declared"}{data?.licence.shareAlike && <span className="block text-muted-foreground-2">Share-alike: keep attribution</span>}</RailFact>
          <RailFact label="Pinned commit"><External href={githubCommitUrl(skill.repo, skill.commit)} mono>{skill.commit.slice(0, 12)}</External></RailFact>
          <RailFact label="Contents">{skill.files} {skill.files === 1 ? "file" : "files"}, {size(skill.bytes)}</RailFact>
          <RailFact label="Permissions"><ul className="flex flex-col gap-2">{["Instructions the agent follows with your permissions", ...(skill.hasScripts ? ["Carries scripts. 0 stores them and never runs them"] : []), "Never updates by itself"].map(item => <li key={item} className="flex gap-2"><span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground-2" /><span>{item}</span></li>)}</ul></RailFact>
        </dl>
      </aside>
    </div>
    {data && <AddSkillDialog open={dialog === "add"} onOpenChange={open => { if (!open) close(); }} preview={data} pending={install.isPending} error={install.error} onConfirm={() => install.mutate({ id: skill.id, sha: data.sha }, { onSuccess: close })} />}
    <ConfirmDialog open={dialog === "remove"} onOpenChange={open => { if (!open) close(); }} pending={remove.isPending} spinner destructive confirmLabel="Remove" title={`Remove ${skill.title}?`} description="The skill folder and its record are deleted from your workspace. You can add it again later." error={<Feedback error={remove.error} />}
      onConfirm={() => remove.mutate(installed!.name, { onSuccess: close })} />
  </PageContent>;
}
