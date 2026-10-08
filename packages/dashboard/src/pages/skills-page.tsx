import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Download, FolderPlus, Plus, Search, Upload } from "lucide-react";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Markdown } from "@/console/markdown";
import { cn } from "@/lib/utils";

type Skill = { id: string; name: string; description: string; scope: string; revision: string; writable: boolean; fileCount: number; source: string };
type Inventory = { skills: Skill[]; mounts: { id: string; path: string }[]; diagnostics: { path?: string; message: string }[]; workspacePath: string };
type Detail = Skill & { content: string; files: { path: string; size: number }[] };
const scopeLabel = (scope: string, team: boolean) => ({ builtin: "Built in", workspace: team ? "Team" : "Workspace", personal: "Personal", project: "Project", mounted: "Mounted" })[scope] ?? scope;
const endpoint = (id: string) => `/api/skills/${encodeURIComponent(id)}`;

export function SkillsPage() {
  const { webFetch, webFetchJson, client } = useBackendApi();
  const team = useTeamAccess();
  const writable = !team.enabled || team.user?.role !== "viewer";
  const canMount = !team.enabled || team.user?.role === "owner";
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("skill");
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<"create" | "mount" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [path, setPath] = useState("");
  const [draft, setDraft] = useState<{ id: string; revision: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const folderInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  const inventory = useQuery({ queryKey: ["skills", client.backendId], queryFn: ({ signal }) => webFetchJson<Inventory>("/api/skills", { signal }), refetchInterval: 5000 });
  const detail = useQuery({ queryKey: ["skill", client.backendId, selectedId], enabled: Boolean(selectedId), queryFn: ({ signal }) => webFetchJson<{ skill: Detail }>(endpoint(selectedId!), { signal }), refetchInterval: 5000 });
  const select = (id: string) => { setSearch(previous => { const next = new URLSearchParams(previous); next.set("skill", id); return next; }); setDraft(null); setError(""); };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update skills."); }
    finally { setBusy(false); }
  };
  const post = (url: string, body: unknown) => webFetchJson<{ skill?: Skill }>(url, { method: "POST", body: JSON.stringify(body) });
  const imported = async (bundle: unknown) => {
    const result = await post("/api/skills/import", { bundle });
    await inventory.refetch();
    if (result.skill) select(result.skill.id);
  };
  const importFolder = async (files: FileList) => {
    const entries = Array.from(files);
    if (entries.length > 256 || entries.reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024) throw new Error("Choose a skill folder under 8 MB with at most 256 files.");
    const root = entries[0]?.webkitRelativePath.split("/")[0];
    if (!root) throw new Error("Choose a folder containing SKILL.md.");
    const content = await Promise.all(entries.map(async file => {
      const relative = file.webkitRelativePath.slice(root.length + 1);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { path: relative, encoding: "base64", content: btoa(binary) };
    }));
    await imported({ format: "agent-skill", version: 1, name: root, files: content });
  };
  const download = async () => {
    if (!selectedId) return;
    const response = await webFetch(`${endpoint(selectedId)}/export`);
    if (!response.ok) throw new Error("Could not export the skill.");
    const blob = await response.blob(); client.signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${detail.data?.skill.name ?? "skill"}.skill.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const skill = detail.data?.skill;
  const visible = inventory.data?.skills.filter(item => `${item.name} ${item.description} ${item.scope}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <main aria-label="Skills" className="space-y-6">
    <PageHeader title="Skills" summary="Reusable instructions for the agent." actions={<>
      {canMount && <Button variant="outline" size="sm" onClick={() => { setDialog("mount"); setError(""); }}><FolderPlus className="size-4" />Mount folder</Button>}
      {writable && <><DropdownMenu><DropdownMenu.Trigger render={<Button variant="outline" size="sm" disabled={busy} />}><Upload className="size-4" />Import</DropdownMenu.Trigger><DropdownMenu.Content align="end"><DropdownMenu.Item onClick={() => folderInput.current?.click()}>Skill folder</DropdownMenu.Item><DropdownMenu.Item onClick={() => bundleInput.current?.click()}>Exported skill</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu><Button size="sm" onClick={() => { setDialog("create"); setError(""); }}><Plus className="size-4" />New skill</Button></>}
    </>} />
    <input ref={folderInput} type="file" className="hidden" multiple {...{ webkitdirectory: "" }} aria-label="Import skill folder" onChange={event => { const files = event.currentTarget.files; if (files?.length) void perform(() => importFolder(files)); event.currentTarget.value = ""; }} />
    <input ref={bundleInput} type="file" className="hidden" accept=".json" aria-label="Import exported skill" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void perform(async () => { if (file.size > 12 * 1024 * 1024) throw new Error("Choose an export under 12 MB."); await imported(JSON.parse(await file.text())); }); event.currentTarget.value = ""; }} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {inventory.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{inventory.error.message}</p><Button variant="outline" onClick={() => void inventory.refetch()}>Retry</Button></div>}
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-3"><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input type="search" aria-label="Search skills" placeholder="Search skills" value={filter} onChange={event => setFilter(event.target.value)} className="pl-9" /></div>
        {inventory.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading skills…</p> : <nav aria-label="Skill library" className="max-h-[60vh] space-y-1 overflow-y-auto">{visible.map(item => <button key={item.id} type="button" aria-current={selectedId === item.id ? "true" : undefined} onClick={() => select(item.id)} className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary", selectedId === item.id && "bg-muted")}><BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block text-sm font-medium">{item.name}</span><span className="mt-1 block text-xs capitalize text-muted-foreground">{scopeLabel(item.scope, team.enabled)}</span></span></button>)}{visible.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">{filter ? "No matching skills." : "No skills yet."}</p>}</nav>}
        {inventory.data && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Folders</summary><div className="space-y-3 py-2"><p className="break-all">{inventory.data.workspacePath}</p>{inventory.data.mounts.map(mount => <div key={mount.id} className="space-y-1"><p className="break-all">{mount.path}</p>{canMount && <button className="underline underline-offset-4" disabled={busy} onClick={() => void perform(async () => { await webFetchJson(`/api/skills/mounts/${encodeURIComponent(mount.id)}`, { method: "DELETE" }); await inventory.refetch(); })}>Unmount</button>}</div>)}{inventory.data.diagnostics.map((message, index) => <p key={index}>{message.message}</p>)}</div></details>}
      </aside>
      <section className="min-w-0 space-y-4">{!selectedId ? <p className="py-8 text-sm text-muted-foreground">Choose a skill to view its instructions.</p> : detail.error ? <p role="alert" className="text-sm text-destructive">{detail.error.message}</p> : detail.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading skill…</p> : skill && <>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-medium">{skill.name}</h2><p className="mt-1 text-sm text-muted-foreground">{skill.description}</p></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(download)}><Download className="size-4" />Export</Button>{writable && skill.writable && !draft && <Button variant="outline" size="sm" onClick={() => setDraft({ id: skill.id, revision: skill.revision, content: skill.content })}>Edit</Button>}</div></div>
        {draft && draft.revision !== skill.revision && <div className="flex flex-wrap items-center gap-3 text-sm"><p>This skill changed. Your draft is still here.</p><Button variant="outline" size="sm" onClick={() => setDraft({ id: skill.id, revision: skill.revision, content: skill.content })}>Reload latest</Button></div>}
        {draft ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void perform(async () => { await webFetchJson(endpoint(draft.id), { method: "PUT", body: JSON.stringify({ content: draft.content, expectedRevision: draft.revision }) }); setDraft(null); await Promise.all([detail.refetch(), inventory.refetch()]); }); }}><label className="block space-y-2 text-sm"><span>SKILL.md</span><Textarea value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} className="min-h-80 font-mono text-xs" disabled={busy} /></label><div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !writable}>Save</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button></div></form> : <div className="rounded-2xl bg-muted/20 p-5"><Markdown text={skill.content.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} /></div>}
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Files · {skill.files.length}</summary><ul className="space-y-2 py-2">{skill.files.map(file => <li key={file.path}>{file.path} <span className="text-muted-foreground/60">· {file.size} bytes</span></li>)}</ul><p className="break-all">{skill.source}</p></details>
      </>}</section>
    </div>
    <Dialog open={Boolean(dialog)} onOpenChange={open => { if (!open && !busy) setDialog(null); }}><DialogContent><DialogHeader><DialogTitle>{dialog === "mount" ? "Mount a skill folder" : "New skill"}</DialogTitle></DialogHeader><form className="space-y-4" onSubmit={event => { event.preventDefault(); void perform(async () => { if (dialog === "mount") { await post("/api/skills/mounts", { path }); setPath(""); } else { const content = `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${instructions.trim()}\n`; const result = await post("/api/skills", { content }); if (result.skill) select(result.skill.id); setName(""); setDescription(""); setInstructions(""); } await inventory.refetch(); setDialog(null); }); }}>
      {dialog === "mount" ? <label className="block space-y-2 text-sm"><span>Folder on this computer</span><Input value={path} onChange={event => setPath(event.target.value)} placeholder="/path/to/skills" required disabled={busy} /><span className="block text-xs text-muted-foreground">Use a skill folder or a folder containing several skills. Files stay in place.</span></label> : <><label className="block space-y-2 text-sm"><span>Name</span><Input value={name} onChange={event => setName(event.target.value)} placeholder="code-review" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} required disabled={busy} /></label><label className="block space-y-2 text-sm"><span>When to use it</span><Input value={description} onChange={event => setDescription(event.target.value)} maxLength={1024} required disabled={busy} /></label><label className="block space-y-2 text-sm"><span>Instructions</span><Textarea value={instructions} onChange={event => setInstructions(event.target.value)} required disabled={busy} className="min-h-40" /></label>{team.enabled && <p className="text-xs text-muted-foreground">Shared with {team.workspace?.name}.</p>}</>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : dialog === "mount" ? "Mount" : "Create skill"}</Button></div>
    </form></DialogContent></Dialog>
  </main>;
}
