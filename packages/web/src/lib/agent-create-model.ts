import { SENTINEL_LIMITS, type Sentinel, type SentinelPreset } from "@/sentinels/model";

/**
 * View model of the "New agent" dialog: state, defaults and the create request as plain data, so the component is a
 * thin shell. One screen: preset chips, avatar, name, then Folder, Computer and Model rows.
 */
export interface AgentAvatar { color: string; icon: string }
export interface AgentModelPick { providerId: string; model: string }
export interface AgentDraft {
  /** "" is Blank. */
  presetId: string;
  name: string;
  nameTouched: boolean;
  avatar: AgentAvatar;
  avatarTouched: boolean;
  /** Absolute folder path the agent works on; "" means none chosen. */
  folder: string;
  /** Backend id; "local" is this computer. */
  computerId: string;
  /** Null follows the current default model. */
  model: AgentModelPick | null;
}

/** Eleven background colours: the ten preset colours plus the blank default. */
export const AGENT_COLORS = ["#4f6bed", "#ef4444", "#3b82f6", "#f59e0b", "#6366f1", "#8b5cf6", "#22c55e", "#14b8a6", "#f97316", "#06b6d4", "#ec4899"] as const;
export const BLANK_AGENT_AVATAR: AgentAvatar = { color: AGENT_COLORS[0], icon: "agent" };
export const THIS_COMPUTER = "local";
export const NAME_PLACEHOLDER = "Agent";
export const BLANK_PRESET = "";

export function newAgentDraft(defaults: { folder?: string } = {}): AgentDraft {
  return { presetId: BLANK_PRESET, name: "", nameTouched: false, avatar: { ...BLANK_AGENT_AVATAR }, avatarTouched: false, folder: defaults.folder ?? "", computerId: THIS_COMPUTER, model: null };
}

/** The folder a new agent starts on: the most recently used one. */
export const defaultFolder = (recents: readonly string[]): string => recents.find(item => typeof item === "string" && item.startsWith("/")) ?? "";

/**
 * Choosing a preset fills the name and avatar behind the scenes (unless the owner already typed or picked their own);
 * Blank clears what a preset had filled. The instructions travel with the preset id on create.
 */
export function choosePreset(draft: AgentDraft, preset: Pick<SentinelPreset, "id" | "name" | "avatar"> | undefined): AgentDraft {
  const filledName = !draft.nameTouched;
  const filledAvatar = !draft.avatarTouched;
  if (!preset) return { ...draft, presetId: BLANK_PRESET, name: filledName ? "" : draft.name, avatar: filledAvatar ? { ...BLANK_AGENT_AVATAR } : draft.avatar };
  return { ...draft, presetId: preset.id, name: filledName ? preset.name : draft.name, avatar: filledAvatar ? { color: preset.avatar.color, icon: preset.avatar.icon } : draft.avatar };
}
export const setName = (draft: AgentDraft, name: string): AgentDraft => ({ ...draft, name, nameTouched: true });
export const setAvatar = (draft: AgentDraft, avatar: Partial<AgentAvatar>): AgentDraft => ({ ...draft, avatar: { ...draft.avatar, ...avatar }, avatarTouched: true });

export type DraftCheck = { ok: true; name: string } | { ok: false; error: string };
export function checkDraft(draft: AgentDraft): DraftCheck {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Give it a name." };
  if (name.length > SENTINEL_LIMITS.name) return { ok: false, error: `Name must be at most ${SENTINEL_LIMITS.name} characters.` };
  return { ok: true, name };
}

/**
 * The create request. The agent is created active; it has no automations or triggers (a preset only suggests them),
 * so nothing runs on a schedule, and no money is spent, until the owner turns a schedule on from the agent's page.
 */
export function createRequest(draft: AgentDraft): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const checked = checkDraft(draft);
  if (!checked.ok) return checked;
  return {
    ok: true,
    body: {
      name: checked.name,
      avatar: { color: draft.avatar.color, icon: draft.avatar.icon },
      status: "active",
      ...(draft.presetId ? { preset: draft.presetId } : {}),
      ...(draft.folder ? { scope: { repos: [draft.folder] } } : {}),
      ...(draft.computerId !== THIS_COMPUTER ? { hostId: draft.computerId } : {}),
      ...(draft.model ? { model: { providerId: draft.model.providerId, model: draft.model.model } } : {}),
    },
  };
}

/** Where the owner lands after creating: the agent's own thread. */
export const agentThreadHref = (id: string): string => `/agents/${encodeURIComponent(id)}`;

const CADENCE: Record<string, string> = { hourly: "hourly", daily: "daily", weekly: "weekly" };
/** The first message in a new agent's thread. A preset adds its job and says its schedules are off. */
export function agentFirstMessage(agent: Pick<Sentinel, "name" | "mission">, preset: Pick<SentinelPreset, "suggestedAutomations"> | undefined): string[] {
  const lines = [agent.mission ? `I am ${agent.name}. ${agent.mission}` : `I am ${agent.name}. Tell me what I should do.`];
  const scheduled = (preset?.suggestedAutomations ?? []).filter(item => item.trigger.kind === "schedule");
  if (scheduled.length > 0) {
    const cadences = [...new Set(scheduled.map(item => CADENCE[item.trigger.cadence ?? ""] ?? "scheduled"))].join(" and ");
    lines.push(`I suggest ${cadences} runs. None are on: nothing runs by itself until you turn it on in Automations.`);
  }
  return lines;
}

/** Placeholder for the thread composer. */
export const agentComposerPlaceholder = (name: string): string => `Tell ${name} what it should do`;
