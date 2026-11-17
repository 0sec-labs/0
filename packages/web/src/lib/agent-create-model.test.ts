import { describe, expect, it } from "vitest";
import { AGENT_COLORS, agentFirstMessage, agentThreadHref, checkDraft, choosePreset, createRequest, defaultFolder, newAgentDraft, setAvatar, setName } from "./agent-create-model";
import type { SentinelPreset } from "@/sentinels/model";

const preset = { id: "pen-tester", name: "Pen Tester", avatar: { color: "#ef4444", icon: "target" } };
const withSchedule = { suggestedAutomations: [{ name: "Weekly", trigger: { kind: "schedule", cadence: "weekly" }, runIn: "sentinel-home" }, { name: "Manual", trigger: { kind: "manual" }, runIn: "new-mission" }] } as Pick<SentinelPreset, "suggestedAutomations">;

describe("new agent draft", () => {
  it("starts blank with the default avatar, this computer and the default model", () => {
    const draft = newAgentDraft({ folder: "/work/app" });
    expect(draft).toMatchObject({ presetId: "", name: "", folder: "/work/app", computerId: "local", model: null, avatar: { color: AGENT_COLORS[0], icon: "agent" } });
    expect(AGENT_COLORS).toHaveLength(11);
  });
  it("defaults the folder to the latest absolute recent folder", () => {
    expect(defaultFolder(["relative", "/a", "/b"])).toBe("/a");
    expect(defaultFolder([])).toBe("");
  });
  it("a preset fills name and avatar; Blank clears them again", () => {
    const filled = choosePreset(newAgentDraft(), preset);
    expect(filled).toMatchObject({ presetId: "pen-tester", name: "Pen Tester", avatar: { color: "#ef4444", icon: "target" } });
    expect(choosePreset(filled, undefined)).toMatchObject({ presetId: "", name: "", avatar: { icon: "agent" } });
  });
  it("keeps what the owner typed or picked when a preset is chosen", () => {
    const own = setAvatar(setName(newAgentDraft(), "Mine"), { color: "#22c55e" });
    expect(choosePreset(own, preset)).toMatchObject({ presetId: "pen-tester", name: "Mine", avatar: { color: "#22c55e", icon: "agent" } });
  });
});

describe("validation", () => {
  it("needs a name and caps its length", () => {
    expect(checkDraft(newAgentDraft())).toEqual({ ok: false, error: "Give it a name." });
    expect(checkDraft(setName(newAgentDraft(), "   ")).ok).toBe(false);
    expect(checkDraft(setName(newAgentDraft(), "x".repeat(81))).ok).toBe(false);
    expect(checkDraft(setName(newAgentDraft(), " Scout "))).toEqual({ ok: true, name: "Scout" });
  });
});

describe("create request", () => {
  it("creates active, with no automations, and omits unset rows", () => {
    expect(createRequest(setName(newAgentDraft(), "Scout"))).toEqual({ ok: true, body: { name: "Scout", avatar: { color: "#4f6bed", icon: "agent" }, status: "active" } });
  });
  it("carries the preset, folder, computer and model", () => {
    const draft = { ...choosePreset(newAgentDraft({ folder: "/work/app" }), preset), computerId: "mini", model: { providerId: "openai", model: "gpt-6" } };
    expect(createRequest(draft)).toEqual({ ok: true, body: { name: "Pen Tester", avatar: { color: "#ef4444", icon: "target" }, status: "active", preset: "pen-tester", scope: { repos: ["/work/app"] }, hostId: "mini", model: { providerId: "openai", model: "gpt-6" } } });
  });
  it("never sends automations or triggers", () => {
    const result = createRequest(choosePreset(newAgentDraft(), preset));
    expect(result.ok && Object.keys(result.body).some(key => /automation|trigger/i.test(key))).toBe(false);
  });
  it("refuses an empty name", () => { expect(createRequest(newAgentDraft()).ok).toBe(false); });
});

describe("landing", () => {
  it("opens the agent's own thread", () => { expect(agentThreadHref("a/b")).toBe("/agents/a%2Fb"); });
  it("says schedules are off in one line when the preset suggests any", () => {
    const lines = agentFirstMessage({ name: "Pen Tester", mission: "Run scoped tests." }, withSchedule);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("weekly");
    expect(lines[1]).toContain("None are on");
  });
  it("is one line for a blank agent", () => {
    expect(agentFirstMessage({ name: "Scout", mission: "" }, undefined)).toEqual(["I am Scout. Tell me what I should do."]);
  });
});
