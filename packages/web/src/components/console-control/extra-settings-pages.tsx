import { queryKeys } from "@/queries";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { formatTokens } from "@/console/format-tokens";
import { formatCost } from "@/console/panel/views/overview-model";
import { Button } from "@/components/ui/button";
import { QueryState } from "./control-ui";
import { SettingsRow, SettingsSection, SettingsValueRow } from "./settings-section";

const MAX_CHATS = 40;
type ChatUsage = { id: string; title: string; model: string; inputTokens: number; outputTokens: number; costUsd?: number };

/** Spend and tokens of the chats open on this engine. The engine keeps no per-day history, so none is shown. */
export function UsageSettings() {
  const { listConsoleSessions, getConsoleSnapshot, client } = useBackendApi();
  const usage = useQuery({ queryKey: queryKeys.settingsUsage(client.backendId), refetchInterval: 15_000, queryFn: async ({ signal }) => {
    const sessions = (await listConsoleSessions(signal)).slice(0, MAX_CHATS);
    const settled = await Promise.allSettled(sessions.map(session => getConsoleSnapshot(session.id, signal, 1)));
    const rows: ChatUsage[] = [];
    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const snapshot: ConsoleSessionSnapshot = result.value;
      rows.push({ id: sessions[index]!.id, title: snapshot.title || sessions[index]!.title || "Untitled", model: snapshot.runtime?.model ?? "Unknown model", inputTokens: snapshot.usage.inputTokens, outputTokens: snapshot.usage.outputTokens, costUsd: snapshot.usage.costUnavailable ? undefined : snapshot.usage.costUsd });
    });
    return { rows, truncated: sessions.length === MAX_CHATS, failed: settled.filter(item => item.status === "rejected").length };
  } });
  const rows = usage.data?.rows ?? [];
  const byModel = new Map<string, { model: string; chats: number; tokens: number; costUsd: number; priced: boolean }>();
  for (const row of rows) {
    const entry = byModel.get(row.model) ?? { model: row.model, chats: 0, tokens: 0, costUsd: 0, priced: false };
    entry.chats += 1; entry.tokens += row.inputTokens + row.outputTokens;
    if (row.costUsd !== undefined) { entry.costUsd += row.costUsd; entry.priced = true; }
    byModel.set(row.model, entry);
  }
  const models = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
  const totalCost = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  const maxTokens = Math.max(1, ...models.map(model => model.tokens));
  return <div className="flex flex-col gap-10">
    <QueryState pending={usage.isPending} error={usage.error} retry={usage.refetch} />
    {usage.data && <>
      <SettingsSection id="settings-usage-total" title="Open chats" description="Totals for the chats open on this engine. Earlier history by day is not recorded.">
        <SettingsValueRow id="setting-usage-cost" label="Estimated spend" description="Reported or estimated by the model provider." value={rows.some(row => row.costUsd !== undefined) ? formatCost(totalCost) : "Not reported"} />
        <SettingsValueRow id="setting-usage-tokens" label="Tokens" value={formatTokens(totalTokens)} />
        <SettingsValueRow id="setting-usage-chats" label="Chats counted" value={rows.length} />
      </SettingsSection>
      <SettingsSection id="settings-usage-models" title="By model" description="Where the tokens went.">
        {models.length === 0 ? <p className="p-4 text-sm text-muted-foreground-2">No chats yet.</p> : models.map(model => <SettingsRow key={model.model} id={`setting-usage-model-${model.model}`} label={model.model} description={`${model.chats} ${model.chats === 1 ? "chat" : "chats"} · ${formatTokens(model.tokens)} tokens`}>
          <div className="flex items-center gap-3"><span aria-hidden="true" className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(2, Math.round(model.tokens / maxTokens * 100))}%` }} /></span><span className="w-16 text-right text-sm tabular-nums text-muted-foreground-1">{model.priced ? formatCost(model.costUsd) : "—"}</span></div>
        </SettingsRow>)}
      </SettingsSection>
      <SettingsSection id="settings-usage-chats" title="By chat">
        {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground-2">No chats yet.</p> : [...rows].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens).map(row => <SettingsRow key={row.id} id={`setting-usage-chat-${row.id}`} label={row.title} description={`${row.model} · ${formatTokens(row.inputTokens)} in · ${formatTokens(row.outputTokens)} out`}>
          <span className="flex items-center gap-3"><span className="text-sm tabular-nums text-muted-foreground-1">{formatCost(row.costUsd) ?? "—"}</span><Button variant="ghost" size="sm" render={<Link to={`/chats/${encodeURIComponent(row.id)}`} />}>Open</Button></span>
        </SettingsRow>)}
      </SettingsSection>
      {(usage.data.truncated || usage.data.failed > 0) && <p role="status" className="text-sm text-muted-foreground-2">{usage.data.truncated ? `Showing the first ${MAX_CHATS} chats. ` : ""}{usage.data.failed > 0 ? `${usage.data.failed} chats could not be read.` : ""}</p>}
    </>}
  </div>;
}
