import { describe, expect, it, vi } from "vitest";
import { agentThreadHref, choosePreset, createRequest, newAgentDraft } from "@/lib/agent-create-model";
import { isNewAgentOpen, openNewAgent, setNewAgentOpen } from "@/lib/new-agent";
import { createSentinelClient } from "./api";
import { parseView, sentinelHref } from "./model";

const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("create sentinel API call", () => {
  it("posts an active sentinel with the preset and no automations", async () => {
    const fetch = vi.fn(async () => json({ sentinel: { id: "a1" }, suggestedAutomations: [{ name: "Weekly", trigger: { kind: "schedule", cadence: "weekly" } }] }));
    const request = createRequest(choosePreset(newAgentDraft({ folder: "/work/app" }), { id: "pen-tester", name: "Pen Tester", avatar: { color: "#ef4444", icon: "target" } }));
    if (!request.ok) throw new Error(request.error);
    const result = await createSentinelClient(fetch).create(request.body);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/console/sentinels");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Pen Tester", status: "active", preset: "pen-tester", folder: "/work/app" });
    expect(Object.keys(body).filter(key => /automation|trigger|schedule/i.test(key))).toEqual([]);
    expect(result.sentinel.id).toBe("a1");
  });
});

describe("after creating", () => {
  it("lands in the sentinel's own thread; the detail page is a view of it", () => {
    expect(agentThreadHref("a1")).toBe("/sentinels/a1");
    expect(sentinelHref("a1")).toBe("/sentinels/a1");
    expect(sentinelHref("a1", "overview")).toBe("/sentinels/a1?view=overview");
    expect(parseView(null)).toBeNull();
    expect(parseView("overview")).toBe("overview");
    expect(parseView("files")).toBe("overview");
    expect(parseView("activations")).toBe("overview");
    expect(parseView("settings")).toBe("settings");
    expect(parseView("nope")).toBeNull();
  });
  it("every entry point opens one shared dialog state", () => {
    expect(isNewAgentOpen()).toBe(false);
    openNewAgent();
    expect(isNewAgentOpen()).toBe(true);
    setNewAgentOpen(false);
    expect(isNewAgentOpen()).toBe(false);
  });
});
