import { describe, expect, it } from "vitest";
import { createDeduper, notificationsForSessions, notificationsForTransition, type MissionState } from "./notification-transitions";

const mission = (status: MissionState["status"], extra: Partial<MissionState> = {}): MissionState => ({ id: "m1", title: "Probe the API", status, updatedAt: "t1", ...extra });

describe("notificationsForTransition", () => {
  it("raises nothing on first sight or no change", () => {
    expect(notificationsForTransition(undefined, mission("ready"))).toEqual([]);
    expect(notificationsForTransition(mission("working"), mission("working"))).toEqual([]);
  });
  it("reports a finished mission with its title only", () => {
    expect(notificationsForTransition(mission("working"), mission("ready", { updatedAt: "t2" }))).toEqual([{ event: "mission-finished", missionId: "m1", missionTitle: "Probe the API", key: "m1:mission-finished:t2" }]);
    expect(notificationsForTransition(mission("waiting"), mission("ready"))[0]?.event).toBe("mission-finished");
  });
  it("does not report a cancelled or failed run", () => {
    expect(notificationsForTransition(mission("cancelling"), mission("ready"))).toEqual([]);
    expect(notificationsForTransition(mission("working"), mission("failed"))).toEqual([]);
  });
  it("distinguishes approvals from questions", () => {
    expect(notificationsForTransition(mission("working"), mission("waiting"))[0]?.event).toBe("mission-approval");
    expect(notificationsForTransition(mission("working"), mission("waiting", { attention: { kind: "question", id: "d1" } }))[0]).toMatchObject({ event: "mission-question", key: "m1:mission-question:d1" });
  });
  it("notifies again for a new decision while still waiting", () => {
    const first = mission("waiting", { attention: { kind: "approval", id: "d1" } });
    expect(notificationsForTransition(first, mission("waiting", { attention: { kind: "approval", id: "d2" } }))).toHaveLength(1);
  });
  it("falls back to a placeholder title", () => {
    expect(notificationsForTransition(mission("working"), mission("ready", { title: " " }))[0]?.missionTitle).toBe("Untitled mission");
  });
});

describe("notificationsForSessions", () => {
  it("ignores missions that are new to the list", () => {
    expect(notificationsForSessions([], [mission("ready")])).toEqual([]);
    expect(notificationsForSessions([mission("working")], [mission("ready"), { id: "m2", status: "ready" }])).toHaveLength(1);
  });
});

describe("createDeduper", () => {
  it("lets a key through once and forgets the oldest past its limit", () => {
    const first = createDeduper(2);
    expect(first("a")).toBe(true);
    expect(first("a")).toBe(false);
    first("b"); first("c");
    expect(first("a")).toBe(true);
  });
});
