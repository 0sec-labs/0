import { describe, expect, it } from "vitest";
import { SentinelScheduleSchema, nextSentinelFire, describeSentinelSchedule, parseCron, type SentinelSchedule } from "./sentinel-triggers.js";

const schedule = (value: Record<string, unknown>): SentinelSchedule => SentinelScheduleSchema.parse(value);
const iso = (ms: number) => new Date(ms).toISOString();

describe("Sentinel schedules", () => {
  it("fires minute intervals on a fixed grid", () => {
    const s = schedule({ frequency: "minutes", every: 15 });
    expect(iso(nextSentinelFire(s, Date.parse("2026-03-02T10:07:30Z")))).toBe("2026-03-02T10:15:00.000Z");
    expect(iso(nextSentinelFire(s, Date.parse("2026-03-02T10:15:00Z")))).toBe("2026-03-02T10:30:00.000Z");
    expect(SentinelScheduleSchema.safeParse({ frequency: "minutes", every: 1 }).success).toBe(false);
  });

  it("uses wall-clock time in the schedule's timezone, daily and weekdays", () => {
    const daily = schedule({ frequency: "daily", time: "09:00", timezone: "Europe/Zurich" });
    // March 2 2026 is CET (UTC+1).
    expect(iso(nextSentinelFire(daily, Date.parse("2026-03-02T07:00:00Z")))).toBe("2026-03-02T08:00:00.000Z");
    expect(iso(nextSentinelFire(daily, Date.parse("2026-03-02T08:00:00Z")))).toBe("2026-03-03T08:00:00.000Z");
    const weekdays = schedule({ frequency: "weekdays", time: "09:00", timezone: "UTC" });
    // Friday 2026-03-06 after 09:00 -> Monday 2026-03-09.
    expect(iso(nextSentinelFire(weekdays, Date.parse("2026-03-06T09:30:00Z")))).toBe("2026-03-09T09:00:00.000Z");
  });

  it("follows DST: 09:00 Zurich is 07:00Z in summer", () => {
    const daily = schedule({ frequency: "daily", time: "09:00", timezone: "Europe/Zurich" });
    expect(iso(nextSentinelFire(daily, Date.parse("2026-07-01T00:00:00Z")))).toBe("2026-07-01T07:00:00.000Z");
  });

  it("supports weekly, hourly and cron with lists, ranges and steps", () => {
    const weekly = schedule({ frequency: "weekly", weekday: 1, time: "06:30", timezone: "UTC" });
    expect(iso(nextSentinelFire(weekly, Date.parse("2026-03-02T06:30:00Z")))).toBe("2026-03-09T06:30:00.000Z");
    const hourly = schedule({ frequency: "hourly", time: "00:20", timezone: "UTC" });
    expect(iso(nextSentinelFire(hourly, Date.parse("2026-03-02T10:25:00Z")))).toBe("2026-03-02T11:20:00.000Z");
    const cron = schedule({ frequency: "cron", cron: "*/20 8-9 * * 1,3", timezone: "UTC" });
    expect(iso(nextSentinelFire(cron, Date.parse("2026-03-02T08:41:00Z")))).toBe("2026-03-02T09:00:00.000Z");
    expect(iso(nextSentinelFire(cron, Date.parse("2026-03-02T09:41:00Z")))).toBe("2026-03-04T08:00:00.000Z");
    const monthly = schedule({ frequency: "cron", cron: "0 0 1 * *", timezone: "UTC" });
    expect(iso(nextSentinelFire(monthly, Date.parse("2026-03-02T00:00:00Z")))).toBe("2026-04-01T00:00:00.000Z");
  });

  it("rejects malformed schedules", () => {
    for (const bad of [
      { frequency: "cron" }, { frequency: "cron", cron: "* * * *" }, { frequency: "cron", cron: "61 * * * *" }, { frequency: "cron", cron: "*/0 * * * *" },
      { frequency: "daily" }, { frequency: "weekly", time: "09:00" }, { frequency: "daily", time: "25:00" }, { frequency: "daily", time: "09:00", timezone: "Mars/Base" },
    ]) expect(SentinelScheduleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(() => parseCron("0 0 31 2 *")).not.toThrow();
    expect(() => nextSentinelFire(schedule({ frequency: "cron", cron: "0 0 31 2 *", timezone: "UTC" }), Date.parse("2026-01-01T00:00:00Z"))).toThrow(/never fires/);
  });

  it("describes schedules for the UI", () => {
    expect(describeSentinelSchedule(schedule({ frequency: "weekdays", time: "09:00", timezone: "UTC" }))).toBe("Weekdays at 09:00 (UTC)");
    expect(describeSentinelSchedule(schedule({ frequency: "minutes", every: 30 }))).toBe("Every 30 minutes");
  });
});
