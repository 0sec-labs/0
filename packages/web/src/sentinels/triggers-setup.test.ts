import { describe, expect, it } from "vitest";
import { statusLockedByReview } from "../components/findings/findings-model";
import { blankTriggerDraft, triggerRequestFromDraft } from "./model";

describe("agent automation setup", () => {
  it("builds schedule and github-pr trigger requests and validates input", () => {
    const base = blankTriggerDraft("auto-1");
    expect(triggerRequestFromDraft({ ...base, automationId: "" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, frequency: "minutes", every: "2" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, frequency: "minutes", every: "15" })).toMatchObject({ ok: true, request: { schedule: { frequency: "minutes", every: 15 } } });
    expect(triggerRequestFromDraft({ ...base, frequency: "weekly", weekday: "3", time: "08:30" })).toMatchObject({ ok: true, request: { schedule: { weekday: 3, time: "08:30" } } });
    expect(triggerRequestFromDraft({ ...base, frequency: "cron", cron: "0 9 *" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, frequency: "cron", cron: "0 9 * * 1" }).ok).toBe(true);
    expect(triggerRequestFromDraft({ ...base, kind: "github-pr", repo: "nope" }).ok).toBe(false);
    expect(triggerRequestFromDraft({ ...base, kind: "github-pr", repo: "acme/app" })).toMatchObject({ ok: true, request: { kind: "github-pr", github: { repo: "acme/app", commentOnPr: false, includeForks: false } } });
    expect(triggerRequestFromDraft({ ...base, kind: "github-pr", repo: "acme/app", commentOnPr: true, includeForks: true })).toMatchObject({ ok: true, request: { github: { repo: "acme/app", commentOnPr: true, includeForks: true } } });
  });
});

describe("review gate status lock", () => {
  it("only lets a finding be closed while it needs review", () => {
    expect(statusLockedByReview("human_review", "in_progress")).toBe(true);
    expect(statusLockedByReview("human_review", "done")).toBe(false);
    expect(statusLockedByReview("todo", "in_progress")).toBe(false);
  });
});
