import { useRef, useState, type FormEvent } from "react";
import { usePendingGate } from "@/lib/pending-gate";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { CapyCheckIcon as Check, CapyArrowUpRightIcon as ArrowUpRight } from "@/ui/icons/capy";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import { Feedback, TextField } from "@/components/console-control/control-ui";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { SheetPanel } from "@/ui/components/sheet-panel";
import { Markdown } from "@/console/markdown";
import { Cell, Tile } from "./cells";
import { VERIFIED_BY_0, splitSkillMarkdown, VERIFIED_HINT, abbreviateStars, catalogSkillPath, catalogSummary, githubTreeUrl, parseGithubSource, rankCatalog, type CatalogPreview, type CatalogPublisher, type CatalogResponse, type CatalogSkill } from "./skills-catalog-model";

const ROUTE = "/api/console/skills/catalog";

/** Catalog inventory, preview and the add/remove mutations. Nothing here writes until a mutation is called from an explicit click. */
export function useSkillsCatalog() {
  const { webFetchJson, client } = useBackendApi();
  const team = useTeamAccess();
  const queryClient = useQueryClient();
  const scope = [client.backendId, team.user?.workspaceId, team.user?.userId] as const;
  const inventory = useQuery({ queryKey: queryKeys.skillsCatalog(...scope), queryFn: ({ signal }) => webFetchJson<CatalogResponse>(ROUTE, { signal }), staleTime: 30_000 });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.skillsCatalog() }), queryClient.invalidateQueries({ queryKey: queryKeys.skills() }), queryClient.invalidateQueries({ queryKey: queryKeys.skillsCatalogPreview() })]);
  const install = useMutation({ mutationFn: (body: { id: string; sha: string } | { repo: string; path: string; sha: string; ref?: string }) => webFetchJson<{ skill: { id: string; name: string } }>(`${ROUTE}/install`, { method: "POST", body: JSON.stringify(body) }), onSuccess: () => { void refresh(); } });
  const remove = useMutation({ mutationFn: (name: string) => webFetchJson<{ ok: boolean }>(`${ROUTE}/remove`, { method: "POST", body: JSON.stringify({ name }) }), onSuccess: () => { void refresh(); } });
  const preview = (body: { id: string } | { repo: string; path: string; ref?: string }, enabled = true) => ({ queryKey: queryKeys.skillsCatalogPreview(...scope, JSON.stringify(body)), enabled, staleTime: 5 * 60_000, retry: false, queryFn: ({ signal }: { signal?: AbortSignal }) => webFetchJson<CatalogPreview>(`${ROUTE}/preview`, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) }) });
  const canWrite = !team.enabled || team.user?.role !== "viewer";
  return { inventory, install, remove, preview, canWrite };
}

export function usePreview(body: { id: string } | { repo: string; path: string; ref?: string } | null) {
  const catalog = useSkillsCatalog();
  return useQuery(catalog.preview(body ?? { id: "" }, body !== null));
}

function StarCount({ count }: { count: number }) {
  return <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground-1" title={`${count.toLocaleString("en-US")} GitHub stars`}><Star aria-hidden="true" className="size-3.5" /><span>{abbreviateStars(count)}</span></span>;
}

export function CatalogTile({ skill, publisher, size = "md" }: { skill: CatalogSkill; publisher: CatalogPublisher | undefined; size?: "md" | "lg" }) {
  return <Tile avatar={publisher?.avatar ?? ""} name={publisher?.name ?? skill.publisher} verified={skill.verified && Boolean(skill.installed)} verifiedLabel={VERIFIED_BY_0} verifiedHint={VERIFIED_HINT} size={size} />;
}

export function CatalogRow({ skill, publishers }: { skill: CatalogSkill; publishers: Record<string, CatalogPublisher> }) {
  const publisher = publishers[skill.publisher];
  return <Cell to={catalogSkillPath(skill.id)} interactive={false} name={skill.title} description={catalogSummary(skill.summary)}
    tile={<CatalogTile skill={skill} publisher={publisher} />}
    trailing={<span className="flex flex-col items-end gap-0.5 text-sm"><StarCount count={skill.stars} /><span className="inline-flex max-w-32 items-center gap-1 text-muted-foreground-2">{skill.installed && <Check role="img" aria-label="Added" className="size-3.5 shrink-0 text-muted-foreground-1" />}<span className="truncate">{publisher?.name ?? skill.publisher}</span></span></span>} />;
}

/** The ranked "From GitHub" list in two columns of rows. Loading shows nothing for 250 ms; an empty view is one line. */
export function GithubSkillsSection({ query }: { query: string }) {
  const { inventory } = useSkillsCatalog();
  const data = inventory.data;
  const loading = usePendingGate(inventory.isPending);
  const rows = data ? rankCatalog(data.skills, data.publishers, query, "all") : [];
  return <section aria-label="From GitHub" className="flex flex-col gap-3">
    {loading && <LoadingState label="Loading skills…" />}
    {inventory.error && <div className="flex flex-col items-start gap-3"><Feedback error={inventory.error} /><Button variant="outline" onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {!loading && data && rows.length === 0 && <p className="text-sm text-muted-foreground-2">{query.trim() ? "No matching skills." : "No skills are listed in this view."}</p>}
    {!loading && data && rows.length > 0 && <ul className="grid grid-cols-1 gap-x-12 gap-y-4 md:grid-cols-2">{rows.map(skill => <CatalogRow key={skill.id} skill={skill} publishers={data.publishers} />)}</ul>}
  </section>;
}

/** Confirmation shown after the preview: licence, pinned commit and one line about trust. */
export function AddSkillDialog({ open, onOpenChange, preview, pending, error, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; preview: CatalogPreview; pending: boolean; error: unknown; onConfirm: () => void }) {
  return <ConfirmDialog open={open} onOpenChange={onOpenChange} pending={pending} spinner confirmLabel="Add skill" title={`Add ${preview.title}?`}
    description="The agent follows these instructions with your permissions, exactly as written at this commit. Review them first." error={<Feedback error={error} />} onConfirm={onConfirm}>
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground-2">Repository</dt><dd className="break-all">{preview.repo}{preview.path ? `/${preview.path}` : ""}</dd>
      <dt className="text-muted-foreground-2">Commit</dt><dd className="font-mono text-xs break-all">{preview.sha}</dd>
      <dt className="text-muted-foreground-2">Licence</dt><dd>{preview.licence.spdx ?? "None declared"}<span className="block text-muted-foreground-2">{preview.licence.notice}</span></dd>
    </dl>
    {preview.warnings.length > 0 && <ul aria-label="Review notes" className="flex flex-col gap-1 text-sm text-muted-foreground-1">{preview.warnings.map(item => <li key={item}>{item}</li>)}</ul>}
  </ConfirmDialog>;
}

/** Opens from the Skills tab menu: owner/repo (or a github.com URL), optional folder and revision, review, then add. No badge. */
export function AddFromGithubSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { install, canWrite } = useSkillsCatalog();
  const [source, setSource] = useState("");
  const [path, setPath] = useState("");
  const [ref, setRef] = useState("");
  const [request, setRequest] = useState<{ repo: string; path: string; ref?: string } | null>(null);
    const [added, setAdded] = useState<string | null>(null);
  const [invalid, setInvalid] = useState("");
  const adding = useRef(false);
  const preview = usePreview(request);
  const reset = () => { setRequest(null); setAdded(null); setInvalid(""); install.reset(); };
  const review = (event: FormEvent) => {
    event.preventDefault(); const parsed = parseGithubSource(source);
    if (!parsed) { setInvalid("Enter a repository as owner/repo or paste its GitHub URL."); return; }
    setInvalid(""); install.reset(); setAdded(null);
    const folder = (path.trim() || parsed.path).replace(/^\/+|\/+$/g, ""); const revision = ref.trim() || parsed.ref;
    setRequest({ repo: parsed.repo, path: folder, ...(revision ? { ref: revision } : {}) });
  };
  const data = preview.data;
  return <SheetPanel open={open} onOpenChange={next => { if (!next) reset(); onOpenChange(next); }} locked={install.isPending} title="Add from GitHub repository" description="Read a skill folder from a public repository, review it, then add it. It is pinned to the commit you review and never updates by itself.">
    <form onSubmit={review} className="flex flex-col gap-4">
      <TextField label="Repository" placeholder="owner/repo" value={source} onChange={event => { setSource(event.target.value); setRequest(null); }} autoComplete="off" spellCheck={false} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="Folder (optional)" placeholder="skills/my-skill" value={path} onChange={event => { setPath(event.target.value); setRequest(null); }} autoComplete="off" spellCheck={false} />
        <TextField label="Branch or tag (optional)" placeholder="default branch" value={ref} onChange={event => { setRef(event.target.value); setRequest(null); }} autoComplete="off" spellCheck={false} />
      </div>
      {invalid && <Feedback error={invalid} />}
      <Button type="submit" variant="outline" className="self-start" disabled={!source.trim() || preview.isFetching}>{preview.isFetching ? "Reading…" : "Review"}</Button>
    </form>
    {request && preview.error && <Feedback error={preview.error} />}
    {added && <div className="flex flex-col items-start gap-3"><Feedback message={`Added ${added}.`} /><Button variant="outline" size="sm" render={<Link to="/skills" />}>Open installed skills</Button></div>}
    {data && !added && <section aria-label="Review" className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0"><h3 className="text-base font-medium break-words text-foreground">{data.title}</h3><p className="text-sm text-muted-foreground-1">{data.description}</p></div>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground-2">Commit</dt><dd className="font-mono text-xs break-all">{data.sha}</dd>
        <dt className="text-muted-foreground-2">Licence</dt><dd>{data.licence.spdx ?? "None declared"}<span className="block text-muted-foreground-2">{data.licence.notice}</span></dd>
        <dt className="text-muted-foreground-2">Files</dt><dd>{data.files.length} files{data.hasScripts ? ", includes scripts that 0 never runs" : ""}</dd>
      </dl>
      {data.warnings.length > 0 && <ul aria-label="Review notes" className="flex flex-col gap-1 text-sm text-muted-foreground-1">{data.warnings.map(item => <li key={item}>{item}</li>)}</ul>}
      <div className="max-h-80 overflow-auto rounded-md border-[0.5px] border-border-2 p-3"><SkillMarkdown text={data.skillMd.text} /></div>
      {data.skillMd.truncated && <p className="text-sm text-muted-foreground-2">Showing the first 64 KiB of SKILL.md.</p>}
      <div className="flex items-center gap-3">
        {data.licence.installable
          ? <Button aria-busy={install.isPending || undefined} disabled={!canWrite || Boolean(data.installed) || install.isPending} onClick={() => { if (adding.current) return; adding.current = true; install.mutate({ repo: data.repo, path: data.path, sha: data.sha, ...(request?.ref ? { ref: request.ref } : {}) }, { onSuccess: result => setAdded(result.skill.name), onSettled: () => { adding.current = false; } }); }}>{data.installed ? "Already added" : install.isPending ? "Adding…" : "Add skill"}</Button>
          : <Button variant="outline" render={<a href={githubTreeUrl(data.repo, data.sha, data.path)} target="_blank" rel="noopener noreferrer" />}>View on GitHub<ArrowUpRight aria-hidden="true" /></Button>}
      </div>
      <Feedback error={install.error} />
    </section>}
  </SheetPanel>;
}

/** The pinned SKILL.md as written: its metadata block verbatim, then the rendered instructions. */
export function SkillMarkdown({ text }: { text: string }) {
  const { frontmatter, body } = splitSkillMarkdown(text);
  return <div className="flex min-w-0 flex-col gap-3">
    {frontmatter && <pre aria-label="SKILL.md metadata" className="overflow-x-auto rounded-md bg-secondary p-3 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground-1">{frontmatter}</pre>}
    <Markdown text={body} />
  </div>;
}
