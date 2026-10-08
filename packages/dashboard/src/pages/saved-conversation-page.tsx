import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ConsolePublicMessage, ConsoleSavedSession } from "@0/shared";
import { useBackendApi } from "@/api";
import { Markdown } from "@/console/markdown";
import { ToolActivity } from "@/console/tool-activity";

/** Browsing a retained transcript never resumes an execution or restores grants. */
export function SavedConversationPage() {
  const { savedId } = useParams();
  const { client, webFetchJson } = useBackendApi();
  const query = useQuery({ queryKey: ["saved-transcript", client.backendId, savedId], queryFn: ({ signal }) => webFetchJson<{ meta: ConsoleSavedSession; messages: ConsolePublicMessage[] }>(`/api/console/saved/${encodeURIComponent(savedId!)}`, { signal }) });
  if (query.isPending) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading conversation…</p>;
  if (query.error) return <p role="alert" className="p-6 text-sm text-destructive">{query.error.message}</p>;
  const results = new Map(query.data.messages.flatMap(message => message.content.flatMap(block => block.type === "tool_result" ? [[block.tool_use_id, block] as const] : [])));
  return <main className="min-h-0 flex-1 overflow-auto p-6"><div className="mx-auto max-w-3xl space-y-6"><header className="space-y-2"><Link to="/console" className="text-xs text-muted-foreground hover:underline">← Chats</Link><h1 className="text-lg font-medium">{query.data.meta.summary || "Saved conversation"}</h1><p className="text-xs text-muted-foreground">Saved transcript</p></header>{query.data.messages.map((message, index) => {
    const text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n\n");
    const calls = message.content.flatMap(block => block.type === "tool_use" ? [{ id: block.id, name: block.name, arguments: block.input, result: results.get(block.id)?.content, isRunning: false }] : []);
    if (!text && !calls.length) return null;
    return <article key={index} className="space-y-3">{message.role === "user" ? <div className="ml-auto max-w-[92%] rounded-2xl bg-muted/50 px-4 py-3 text-sm">{message.author && <p className="mb-1 text-xs text-muted-foreground">{message.author.displayName}</p>}<Markdown text={text} /></div> : <>{calls.length > 0 && <ToolActivity calls={calls} working={false} />}{text && <Markdown text={text} />}</>}</article>;
  })}</div></main>;
}
