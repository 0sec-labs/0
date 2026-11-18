import { useState } from "react";
import { v } from "@/lib/vocabulary";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/console/markdown";
import { cn } from "@/lib/utils";
import { useSentinelClient, useSentinelFile, useSentinelMutations } from "@/sentinels/api";
import { SENTINEL_LIMITS, fileBytes, isConflict, type SentinelFile } from "@/sentinels/model";

/** The file title (a first "# Name" line) repeats the section title, so it stays out of the reading view. */
const readable = (content: string): string => content.replace(/^\s*# .*\n+/, "");

interface Base { revision: number | null; content: string }

function Body({ sentinelId, path, base, empty, readOnly, onBase }: { sentinelId: string; path: string; base: Base; empty: string; readOnly: boolean; onBase: (next: Base) => void }) {
  const { client } = useSentinelClient();
  const { saveFile } = useSentinelMutations();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(base.content);
  const [conflict, setConflict] = useState<SentinelFile | null>(null);
  const [error, setError] = useState("");
  const dirty = text !== base.content;
  const tooLarge = fileBytes(text) > SENTINEL_LIMITS.fileBytes;
  const save = async (revision: number | null) => {
    setError("");
    try {
      const file = await saveFile.mutateAsync({ id: sentinelId, path, content: text, revision });
      onBase({ revision: file.revision, content: file.content }); setText(file.content); setConflict(null); setEditing(false);
    } catch (cause) {
      if (isConflict(cause)) { try { setConflict((await client.file(sentinelId, path)).file); } catch { setError("This file changed elsewhere and could not be reloaded."); } }
      else setError(cause instanceof Error ? cause.message : "Unable to save.");
    }
  };
  if (!editing) return <div className="space-y-2">
    {readable(base.content).trim()
      ? <div className="[&_h1]:text-[13px]! [&_h2]:text-[13px]! [&_h3]:text-[13px]! [&_h1]:font-medium! [&_h2]:font-medium! [&_h3]:font-medium! [&_h1]:mt-4! [&_h2]:mt-4! [&_h3]:mt-4! [&_h1]:mb-1! [&_h2]:mb-1! [&_h3]:mb-1! [&_h1]:text-muted-foreground-1! [&_h2]:text-muted-foreground-1! [&_h3]:text-muted-foreground-1! [&_h1:first-child]:mt-0! [&_h2:first-child]:mt-0!" data-slot="document-text"><Markdown text={readable(base.content)} /></div>
      : <p className="text-sm text-muted-foreground-1">{empty}</p>}
    {!readOnly && <Button type="button" variant="ghost" size="xs" className="-ml-2" onClick={() => { setText(base.content); setEditing(true); }}>Edit</Button>}
  </div>;
  return <div className="space-y-2">
    <Textarea aria-label={`Edit ${path}`} value={text} spellCheck={false} rows={10} className="max-h-96 min-h-40 overflow-y-auto font-mono text-xs" onChange={event => { setText(event.target.value); setConflict(null); }} />
    {conflict && <div role="alert" className="space-y-2 rounded-md bg-amber-500/10 p-2.5 text-xs">
      <p>It changed since you opened it, by {conflict.authorKind === "agent" ? v("the {sentinel}") : conflict.author}. Your edits are still here.</p>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" variant="secondary" onClick={() => { onBase({ revision: conflict.revision, content: conflict.content }); setText(conflict.content); setConflict(null); }}>Use theirs</Button>
        <Button type="button" size="xs" variant="secondary" onClick={() => void save(conflict.revision)}>Overwrite</Button>
      </div>
    </div>}
    {tooLarge && <p className={cn("text-xs text-destructive")}>Too long: {fileBytes(text).toLocaleString()} of {SENTINEL_LIMITS.fileBytes.toLocaleString()} bytes.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex items-center gap-1.5">
      <Button type="button" size="xs" variant="secondary" disabled={!dirty || tooLarge || saveFile.isPending} onClick={() => void save(base.revision)}>{saveFile.isPending ? "Saving" : "Save"}</Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => { setText(base.content); setConflict(null); setError(""); setEditing(false); }}>Revert</Button>
    </div>
  </div>;
}

/** One of the Sentinel's files as readable text, with an inline editor behind Edit. Revision numbers stay out of sight; a conflict is the only time they matter. */
export function SentinelDocument({ sentinelId, path, empty, readOnly = false }: { sentinelId: string; path: string; empty: string; readOnly?: boolean }) {
  const query = useSentinelFile(sentinelId, path);
  const [override, setOverride] = useState<Base | null>(null);
  if (query.isLoading) return <div className="h-6" aria-busy="true" />;
  if (query.error || !query.data) return <p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : "Unable to load."}</p>;
  const { file } = query.data;
  const base = override && override.revision !== null && override.revision >= file.revision ? override : { revision: file.revision, content: file.content };
  return <Body key={`${path}:${base.revision}`} sentinelId={sentinelId} path={path} base={base} empty={empty} readOnly={readOnly} onBase={setOverride} />;
}
