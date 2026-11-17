import { describe, expect, test } from "vitest";
import type { AgentTurn } from "../src/sentinels/model";
import { CAUSE_LABEL, parseWakeHeader, turnLabel, wakeSummary, workedFor } from "../src/sentinels/wake";

const turn = (patch: Partial<AgentTurn>): AgentTurn => ({ id: "abcdef12-0000", agentId: "a", origin: "schedule", detail: {}, status: "completed", startedAt: "2026-03-02T10:05:00.000Z", finishedAt: "2026-03-02T10:05:54.000Z", ...patch });

describe("wake-up lines", () => {
  test("reads the header of a trigger turn and nothing else", () => {
    expect(parseWakeHeader('[Turn from schedule "Daily check" at 2026-03-02 10:05 UTC · turn abcdef12]\n\nYou are the Agent')).toEqual({ source: 'schedule "Daily check" at 2026-03-02 10:05 UTC', nonce: "abcdef12", origin: "schedule" });
    expect(parseWakeHeader("[Turn from GitHub pull request acme/app#12 · turn 0123abcd]")).toMatchObject({ nonce: "0123abcd", origin: "github" });
    expect(parseWakeHeader("Please look at the lockfile")).toBeNull();
    expect(parseWakeHeader("Quote: [Turn from schedule x · turn abcdef12]")).toBeNull();
  });
  test("one quiet sentence: cause, how long, and a failure", () => {
    const header = parseWakeHeader("[Turn from schedule x · turn abcdef12]")!;
    expect(wakeSummary(header, turn({}))).toEqual({ text: "Woke on schedule, worked for 54s", failed: false, working: false });
    expect(wakeSummary(header, turn({ status: "failed", error: "boom" }))).toMatchObject({ text: "Woke on schedule, worked for 54s, failed", failed: true });
    expect(wakeSummary(header, turn({ status: "queued", startedAt: undefined, finishedAt: undefined })).text).toBe("Woke on schedule, waiting its turn");
    expect(wakeSummary(header, turn({ status: "running", finishedAt: undefined }), Date.parse("2026-03-02T10:06:08Z"))).toMatchObject({ text: "Woke on schedule, working for 1m 8s", working: true });
    expect(wakeSummary(header, undefined).text).toBe("Woke on schedule");
    expect(wakeSummary(parseWakeHeader("[Turn from GitHub pull request a/b#3 · turn abcdef12]")!, turn({ origin: "github" })).text).toBe("Woke on a pull request, worked for 54s");
  });
  test("cause chips and labels use the product words", () => {
    expect(CAUSE_LABEL).toEqual({ schedule: "Schedule", github: "GitHub", user: "You", promote: "Promoted", legacy: "Earlier" });
    expect(turnLabel({ origin: "github", detail: { event: { pr: 7, repo: "acme/app" } } })).toBe("Pull request #7 on acme/app");
    expect(turnLabel({ origin: "user", detail: {} })).toBe("Your message");
    expect(Object.values(CAUSE_LABEL).join(" ") + turnLabel({ origin: "schedule", detail: {} })).not.toMatch(/\brun/i);
    expect(workedFor(3_725_000)).toBe("1h 2m");
  });
});

describe("editing a schedule in place", () => {
  test("a stored schedule becomes the draft the fields edit, and round-trips through the request", async () => {
    const { draftFromSchedule, triggerRequestFromDraft } = await import("../src/sentinels/model");
    const schedule = { frequency: "weekly" as const, weekday: 3, time: "07:30", timezone: "Europe/Zurich" };
    const draft = draftFromSchedule(schedule, "auto-1");
    expect(draft).toMatchObject({ kind: "schedule", frequency: "weekly", weekday: "3", time: "07:30", timezone: "Europe/Zurich", automationId: "auto-1" });
    expect(triggerRequestFromDraft(draft)).toEqual({ ok: true, request: { automationId: "auto-1", kind: "schedule", schedule } });
    const every = draftFromSchedule({ frequency: "minutes", every: 30, timezone: "UTC" }, "a");
    expect(triggerRequestFromDraft({ ...every, every: "3" })).toMatchObject({ ok: false });
  });
});
