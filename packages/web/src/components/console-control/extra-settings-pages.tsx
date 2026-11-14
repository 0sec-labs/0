import { useQuery } from "@tanstack/react-query";
import { Blocks, KeyRound, Sparkles, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { formatTokens } from "@/console/format-tokens";
import { formatCost } from "@/console/panel/views/overview-model";
import { Button } from "@/components/ui/button";
import { QueryState } from "./control-ui";
import { SettingsLinkRow, SettingsRow, SettingsSection, SettingsValueRow } from "./settings-section";
import type { PluginsResponse } from "./contracts";

const MAX_CHATS = 40;
type ChatUsage = { id: string; title: string; model: string; inputTokens: number; outputTokens: number; costUsd?: number };

/** Spend and tokens of the chats open on this engine. The engine keeps no per-day history, so none is shown. */
export function UsageSettings() {
  const { listConsoleSessions, getConsoleSnapshot, client } = useBackendApi();
  const usage = useQuery({ queryKey: ["settings-usage", client.backendId], refetchInterval: 15_000, queryFn: async ({ signal }) => {
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
          <span className="flex items-center gap-3"><span className="text-sm tabular-nums text-muted-foreground-1">{formatCost(row.costUsd) ?? "—"}</span><Button asChild variant="ghost" size="sm"><Link to={`/console/${encodeURIComponent(row.id)}`}>Open</Link></Button></span>
        </SettingsRow>)}
      </SettingsSection>
      {(usage.data.truncated || usage.data.failed > 0) && <p role="status" className="text-sm text-muted-foreground-2">{usage.data.truncated ? `Showing the first ${MAX_CHATS} chats. ` : ""}{usage.data.failed > 0 ? `${usage.data.failed} chats could not be read.` : ""}</p>}
    </>}
  </div>;
}

type WorkspaceMember = { userId: string; displayName: string; role: "owner" | "editor" | "viewer" };
/** Workspace members. Adding people stays on the team page, which owns the account form. */
export function MembersSettings() {
  const team = useTeamAccess();
  const { webFetchJson } = useBackendApi();
  const members = useQuery({ queryKey: ["team-users", team.workspace?.id], enabled: team.enabled && Boolean(team.user), queryFn: ({ signal }) => webFetchJson<{ users: WorkspaceMember[] }>("/api/team/users", { signal }) });
  if (!team.enabled) return <SettingsSection id="settings-members" title="Workspace" description="This is a solo workspace, so there is nobody else to manage.">
    <SettingsLinkRow id="setting-members-create" to="/onboarding?step=workspace&mode=team" title="Create a team workspace" subtitle="Invite teammates and share chats, skills and findings." />
  </SettingsSection>;
  const owner = team.user?.role === "owner";
  return <div className="flex flex-col gap-10">
    <QueryState pending={members.isPending} error={members.error} retry={members.refetch} />
    <SettingsSection id="settings-members" title={team.workspace?.name ?? "Workspace"} description={`${members.data?.users.length ?? 0} members`} action={owner ? <Button asChild variant="outline" size="sm"><Link to="/team">Add teammate</Link></Button> : undefined}>
      {(members.data?.users ?? []).map(member => <SettingsRow key={member.userId} id={`setting-member-${member.userId}`} label={member.displayName} badge={member.userId === team.user?.userId ? "You" : undefined} description={member.userId}><span className="rounded-full border-[0.5px] border-border-2 bg-card px-2 py-0.5 text-xs capitalize text-muted-foreground-1">{member.role}</span></SettingsRow>)}
      {members.data && members.data.users.length === 0 && <p className="p-4 text-sm text-muted-foreground-2">No members found.</p>}
    </SettingsSection>
    <SettingsSection id="settings-members-access" title="Access">
      <SettingsLinkRow id="setting-members-manage" to="/team" title="Manage team" subtitle={owner ? "Add teammates and set their roles." : "Your workspace owner manages teammates."} />
      <SettingsLinkRow id="setting-members-api" to="/api-access" title="Findings API" subtitle="Read-only access tokens for findings." />
    </SettingsSection>
  </div>;
}

/** Where plugins, connections, models and tools are managed, with a live plugin count. */
export function IntegrationsSettings() {
  const { webFetchJson } = useBackendApi();
  const plugins = useQuery({ queryKey: ["console-plugins"], queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }) });
  const all = plugins.data?.items.filter(item => item.kind === "plugin");
  const enabled = all?.filter(item => item.state === "enabled" || item.state === "active").length;
  return <SettingsSection id="settings-integrations" title="Extend this engine" description="Services, plugins and tools your chats can use.">
    <SettingsLinkRow id="setting-integrations-plugins" to="/plugins" icon={<Blocks aria-hidden="true" className="size-(--icon-sm)" />} title="Plugins" kind="Plugins and services" subtitle="Install, enable and review plugins and service connections." value={all ? `${enabled} of ${all.length} enabled` : undefined} />
    <SettingsLinkRow id="setting-integrations-connections" to="/connections" icon={<KeyRound aria-hidden="true" className="size-(--icon-sm)" />} title="Connections" kind="Model providers" subtitle="Sign in to a provider or add an API key." />
    <SettingsLinkRow id="setting-integrations-models" to="/models" icon={<Sparkles aria-hidden="true" className="size-(--icon-sm)" />} title="Models" subtitle="Choose the model and reasoning each role uses." />
    <SettingsLinkRow id="setting-integrations-tools" to="/tools" icon={<Wrench aria-hidden="true" className="size-(--icon-sm)" />} title="Tools" subtitle="See the tools available to a chat." />
  </SettingsSection>;
}

/** Skills library entry point with a live count. */
export function SkillsSettings() {
  const { webFetchJson, client } = useBackendApi();
  const team = useTeamAccess();
  const skills = useQuery({ queryKey: ["skills", client.backendId, team.user?.workspaceId, team.user?.userId], queryFn: ({ signal }) => webFetchJson<{ skills: { id: string }[] }>("/api/skills", { signal }) });
  return <SettingsSection id="settings-skills" title="Skills" description="Instructions the agent uses when a task matches.">
    <SettingsLinkRow id="setting-skills-library" to="/skills" title="Skills library" subtitle="Create, edit and import skills for this workspace." value={skills.data ? `${skills.data.skills.length} skills` : undefined} />
  </SettingsSection>;
}
