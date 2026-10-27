import { LoadingState } from "@/components/state-panel";
import { Disclosure } from "@/components/ui/disclosure";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, FileText, FolderPlus, MoreHorizontal, Plus, Upload } from "lucide-react";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { PageHeader, PageContent } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Markdown } from "@/console/markdown";
import { SkillsLibrary } from "@/components/skills-library";
import { EditorChat } from "@/components/editor-chat";

type Skill = { id: string; name: string; description: string; scope: string; revision: string; writable: boolean; fileCount: number; source: string };
type Inventory = { skills: Skill[]; mounts: { id: string; path: string }[]; diagnostics: { path?: string; message: string }[]; workspacePath: string };
type SkillDraft = { id: string; revision: string; content: string; copy?: boolean };
type Detail = Skill & { content: string; files: { path: string; size: number }[] };
const scopeLabel = (scope: string, team: boolean) => ({ builtin: "Built in", workspace: team ? "Team" : "Workspace", personal: "Solo", project: "Project", mounted: "Mounted" })[scope] ?? scope;
const endpoint = (id: string) => `/api/skills/${encodeURIComponent(id)}`;

export function SkillsPage() {
  const { webFetch, webFetchJson, client } = useBackendApi();
  const team = useTeamAccess();
  const writable = !team.enabled || team.user?.role !== "viewer";
  const canMount = !team.enabled || team.user?.role === "owner";
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("skill");
  const [previewTab, setPreviewTab] = useState<"instructions" | "files" | "source">("instructions");
  const [dialog, setDialog] = useState<"create" | "mount" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newSkillPrompt, setNewSkillPrompt] = useState<{ id: string; text: string } | null>(null);
  const [path, setPath] = useState("");
  const [drafts, setDrafts] = useState<Record<string, SkillDraft>>({});
  const draftKey = selectedId ? JSON.stringify([client.backendId, team.user?.workspaceId, team.user?.userId, selectedId]) : null;
  const draft = draftKey ? drafts[draftKey] ?? null : null;
  const setDraft = (value: SkillDraft | null) => {
    if (!draftKey) return;
    setDrafts(previous => {
      const next = { ...previous };
      if (value) next[draftKey] = value;
      else delete next[draftKey];
      return next;
    });
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const markdownInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  const inventory = useQuery({ queryKey: ["skills", client.backendId, team.user?.workspaceId, team.user?.userId], queryFn: ({ signal }) => webFetchJson<Inventory>("/api/skills", { signal }), refetchInterval: 5000 });
  const detail = useQuery({ queryKey: ["skill", client.backendId, team.user?.workspaceId, team.user?.userId, selectedId], enabled: Boolean(selectedId), queryFn: ({ signal }) => webFetchJson<{ skill: Detail }>(endpoint(selectedId!), { signal }), refetchInterval: selectedId ? 1000 : 5000 });
  const select = (id: string) => { setPreviewTab("instructions"); setSearch(previous => { const next = new URLSearchParams(previous); next.set("skill", id); return next; }); setError(""); };
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
  const download = async (format: "markdown" | "bundle") => {
    if (!selectedId) return;
    let blob: Blob;
    if (format === "markdown") { if (!detail.data?.skill) throw new Error("Choose a skill first."); blob = new Blob([detail.data.skill.content], { type: "text/markdown;charset=utf-8" }); }
    else { const response = await webFetch(`${endpoint(selectedId)}/export`); if (!response.ok) throw new Error("Could not export the skill."); blob = await response.blob(); }
    client.signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = format === "markdown" ? "SKILL.md" : `${detail.data?.skill.name ?? "skill"}.skill.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const skill = detail.data?.skill;
  const exportDisabled = busy || !selectedId || !skill;
  const exportTrigger = <DropdownMenu.Trigger render={<Button variant="outline" size="sm" disabled={exportDisabled} />}><Download className="size-4" />Export</DropdownMenu.Trigger>;
  const openSource = () => { if (!skill) return; setPreviewTab("source"); if (writable) setDraft({ id: skill.id, revision: skill.revision, content: skill.writable ? skill.content : skill.content.replace(/^name:.*$/m, `name: ${JSON.stringify(`${skill.name.slice(0, 57)}-custom`)}`), copy: !skill.writable }); };
  return <PageContent width="wide" aria-label="Skills">
    {selectedId && <Button variant="ghost" size="sm" onClick={() => setSearch(previous => { const next = new URLSearchParams(previous); next.delete("skill"); return next; })}><ArrowLeft className="size-4" />Back to skills</Button>}
    <PageHeader title={skill?.name ?? "Skills"} summary={selectedId ? skill?.description : "Reusable expertise. Refine it in chat, then use it across your agents."} actions={<>
      {!selectedId && canMount && <Button variant="ghost" size="sm" onClick={() => { setDialog("mount"); setError(""); }}><FolderPlus className="size-4" />Mount folder</Button>}
      {!selectedId && writable && <DropdownMenu><DropdownMenu.Trigger render={<Button variant="ghost" size="sm" disabled={busy} />}><Upload className="size-4" />Import</DropdownMenu.Trigger><DropdownMenu.Content align="end"><DropdownMenu.Item onClick={() => markdownInput.current?.click()}>SKILL.md file</DropdownMenu.Item><DropdownMenu.Item onClick={() => folderInput.current?.click()}>Skill folder</DropdownMenu.Item><DropdownMenu.Item onClick={() => bundleInput.current?.click()}>Exported skill</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu>}
      {selectedId && skill && <><span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">{skill.writable ? <><Check className="size-3.5" />Saved</> : scopeLabel(skill.scope, team.enabled)}</span><DropdownMenu>{exportTrigger}<DropdownMenu.Content align="end"><DropdownMenu.Item onClick={() => void perform(() => download("markdown"))}>SKILL.md</DropdownMenu.Item><DropdownMenu.Item onClick={() => void perform(() => download("bundle"))}>All files</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu><DropdownMenu><DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="More skill options" />}><MoreHorizontal className="size-4" /></DropdownMenu.Trigger><DropdownMenu.Content align="end"><DropdownMenu.Item disabled={busy} onClick={openSource}>{writable ? skill.writable ? "Edit source" : "Customize source" : "View source"}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu></>}
      {!selectedId && writable && <Button size="sm" onClick={() => { setDialog("create"); setError(""); }}><Plus className="size-4" />New skill</Button>}
    </>} />
    <input ref={markdownInput} type="file" className="hidden" accept=".md,text/markdown,text/plain" aria-label="Import skill Markdown" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void perform(async () => { if (file.size > 131072) throw new Error("Choose a SKILL.md file under 128 KB."); const result = await post("/api/skills", { content: await file.text() }); await inventory.refetch(); if (result.skill) select(result.skill.id); }); event.currentTarget.value = ""; }} />
    <input ref={folderInput} type="file" className="hidden" multiple {...{ webkitdirectory: "" }} aria-label="Import skill folder" onChange={event => { const files = event.currentTarget.files; if (files?.length) void perform(() => importFolder(files)); event.currentTarget.value = ""; }} />
    <input ref={bundleInput} type="file" className="hidden" accept=".json" aria-label="Import exported skill" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void perform(async () => { if (file.size > 12 * 1024 * 1024) throw new Error("Choose an export under 12 MB."); await imported(JSON.parse(await file.text())); }); event.currentTarget.value = ""; }} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!selectedId ? <SkillsLibrary skills={inventory.data?.skills ?? []} loading={inventory.isPending} error={inventory.error?.message} onRetry={() => void inventory.refetch()} onSelect={select} onCreate={() => { setDialog("create"); setError(""); }} disabled={busy} canCreate={writable} shared={team.enabled} /> : detail.error ? <p role="alert" className="text-sm text-destructive">{detail.error.message}</p> : detail.isPending ? <LoadingState label="Loading skill…" variant="detail" /> : skill && <div className="grid min-h-[620px] gap-3 lg:h-[calc(100dvh-240px)] lg:grid-cols-[minmax(340px,0.85fr)_minmax(0,1.15fr)]">
      <section className="flex min-h-[500px] min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)] bg-background lg:min-h-0" aria-label="Skill editor">
        <div className="flex h-12 shrink-0 items-center border-b border-border/40 px-5 text-sm font-medium">Chat<span className="ml-auto text-xs font-normal text-muted-foreground">{skill.writable ? "Editing this skill" : "Customizes a workspace copy"}</span></div>
        <EditorChat key={`${client.backendId}:skill:${skill.id}`} resource={{ kind: "skill", id: skill.id, name: skill.name }} initialPrompt={newSkillPrompt?.id === skill.id ? newSkillPrompt.text : undefined} readOnly={!writable} onResourceChange={id => { select(id); void inventory.refetch(); }} />
      </section>
      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)] bg-muted/20" aria-label="Skill preview">
        <nav aria-label="Skill preview sections" className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3">
          {(["instructions", "files"] as const).map(tab => <Button key={tab} size="sm" variant="ghost" aria-current={previewTab === tab ? "page" : undefined} onClick={() => setPreviewTab(tab)} className={previewTab === tab ? "bg-muted text-foreground" : "text-muted-foreground"}>{tab === "instructions" ? "Instructions" : `Files · ${skill.files.length}`}</Button>)}
          {previewTab === "source" && <span className="px-2 text-sm font-medium">Source</span>}
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">{scopeLabel(skill.scope, team.enabled)}</span>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6">
          {previewTab === "instructions" && <Markdown text={skill.content.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} />}
          {previewTab === "files" && <><ul className="divide-y divide-border/40">{skill.files.map(file => <li key={file.path} className="flex items-center gap-3 py-3 text-sm"><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words">{file.path}</span><span className="shrink-0 text-xs text-muted-foreground">{file.size.toLocaleString()} bytes</span></li>)}</ul><Disclosure className="mt-4 text-xs text-muted-foreground" summary={<>Location</>} triggerClassName="py-2"><p className="break-all py-2">{skill.source}</p></Disclosure></>}
          {previewTab === "source" && (draft ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void perform(async () => { const saved = await webFetchJson<{ skill: Skill }>(`${endpoint(draft.id)}${draft.copy ? "/copy" : ""}`, { method: draft.copy ? "POST" : "PUT", body: JSON.stringify({ content: draft.content, expectedRevision: draft.revision }) }); setDraft(null); if (draft.copy) select(saved.skill.id); await Promise.all([detail.refetch(), inventory.refetch()]); }); }}>
            {draft.revision !== skill.revision && <div role="status" className="space-y-2 text-xs"><p>This skill changed. Your draft is kept.</p><Button type="button" variant="outline" size="sm" onClick={openSource}>Reload latest</Button></div>}
            <label className="block space-y-2 text-sm"><span>{draft.copy ? "Customize a workspace copy" : "SKILL.md"}</span><Textarea aria-label="Skill source" value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} className="min-h-80 font-mono text-xs" disabled={busy} /></label>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !writable}>{draft.copy ? "Save copy" : "Save"}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft(null); setPreviewTab("instructions"); }}>Cancel</Button></div>
          </form> : <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6">{skill.content}</pre>)}
        </div>
      </section>
    </div>}
    {!selectedId && inventory.data && <Disclosure className="text-xs text-muted-foreground" summary={<>Folders</>} triggerClassName="py-2"><div className="space-y-3 py-2"><p className="break-all">{inventory.data.workspacePath}</p>{inventory.data.mounts.map(mount => <div key={mount.id}><p className="break-all">{mount.path}</p>{canMount && <Button variant="link" size="sm" disabled={busy} onClick={() => void perform(async () => { await webFetchJson(`/api/skills/mounts/${encodeURIComponent(mount.id)}`, { method: "DELETE" }); await inventory.refetch(); })}>Unmount</Button>}</div>)}{inventory.data.diagnostics.map((message, index) => <p key={index}>{message.message}</p>)}</div></Disclosure>}
    <Dialog open={Boolean(dialog)} onOpenChange={open => { if (!open && !busy) setDialog(null); }}><DialogContent><DialogHeader><DialogTitle>{dialog === "mount" ? "Mount a skill folder" : "New skill"}</DialogTitle>{dialog === "create" && <DialogDescription>Give it a name and a purpose. Refine the instructions in chat.</DialogDescription>}</DialogHeader><form className="space-y-4" onSubmit={event => { event.preventDefault(); void perform(async () => { if (dialog === "mount") { await post("/api/skills/mounts", { path }); setPath(""); } else { const content = `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${description.trim()}\n`; const result = await post("/api/skills", { content }); if (result.skill) { setNewSkillPrompt({ id: result.skill.id, text: `Develop this skill for the following purpose. Read its current content, write clear and practical instructions, and save the skill.\n\n${description.trim()}` }); select(result.skill.id); } setName(""); setDescription(""); } await inventory.refetch(); setDialog(null); }); }}>
      {dialog === "mount" ? <label className="block space-y-2 text-sm"><span>Folder on this computer</span><Input value={path} onChange={event => setPath(event.target.value)} placeholder="/path/to/skills" required disabled={busy} /><span className="block text-xs text-muted-foreground">Use a skill folder or a folder containing several skills. Files stay in place.</span></label> : <><label className="block space-y-2 text-sm"><span>Name</span><Input value={name} onChange={event => setName(event.target.value)} placeholder="code-review" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} required disabled={busy} /></label><label className="block space-y-2 text-sm"><span>What should this skill do?</span><Textarea rows={4} value={description} onChange={event => setDescription(event.target.value)} maxLength={1024} required disabled={busy} /></label>{team.enabled && <p className="text-xs text-muted-foreground">Shared with {team.workspace?.name}.</p>}</>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : dialog === "mount" ? "Mount" : "Create and refine"}</Button></div>
    </form></DialogContent></Dialog>
  </PageContent>;
}
