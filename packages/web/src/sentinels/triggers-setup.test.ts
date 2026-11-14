import { describe, expect, it } from "vitest";
import { sentinelOwnership } from "../components/automations/automation-model";
import { statusLockedByReview } from "../components/findings/findings-model";
import { setupAutomationHref } from "../components/sentinels/sentinel-views";
import { blankTriggerDraft, triggerRequestFromDraft } from "./model";

describe("sentinel automation setup", () => {
  it("carries ownership from the Set up link into the new automation", () => {
    const href = setupAutomationHref("sen_1", { templateId: "repository-review", runIn: "sentinel-home" });
    const params = new URL(href, "http://x").searchParams;
    expect(params.get("template")).toBe("repository-review");
    expect(sentinelOwnership(params)).toEqual({ ownerSentinelId: "sen_1", runIn: "sentinel-home" });
    expect(sentinelOwnership(new URLSearchParams("template=x"))).toBeNull();
    expect(sentinelOwnership(new URLSearchParams("owner=a b"))).toBeNull();
  });
  it("builds schedule and github-pr trigger requests and validates input", () => {
    const base = blankTriggerDraft("auto-1");
    expect(triggerRequestFromDraft({ ...base, automationId: "" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, frequency: "minutes", every: "2" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, frequency: "minutes", every: "15" })).toMatchObject({ ok: true, request: { schedule: { frequency: "minutes", every: 15 } } });
    expect(triggerRequestFromDraft({ ...base, frequency: "weekly", weekday: "3", time: "08:30" })).toMatchObject({ ok: true, request: { schedule: { weekday: 3, time: "08:30" } } });
    expect(triggerRequestFromDraft({ ...base, frequency: "cron", cron: "0 9 *" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, frequency: "cron", cron: "0 9 * * 1" }).ok).toBe(true);
    expect(triggerRequestFromDraft({ ...base, kind: "github-pr", repo: "nope" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, kind: "github-pr", repo: "acme/app" })).toMatchObject({ ok: true, request: { kind: "github-pr", github: { repo: "acme/app" } } });
  });
});

describe("review gate status lock", () => {
  it("only lets a finding be closed while it needs review", () => {
    expect(statusLockedByReview("human_review", "in_progress")).toBe(true);
    expect(statusLockedByReview("human_review", "done")).toBe(false);
    expect(statusLockedByReview("todo", "in_progress")).toBe(false);
  });
});
