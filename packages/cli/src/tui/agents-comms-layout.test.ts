import { describe, expect, it } from "vitest";

import type { HerdSubagentMap, HerdSubagentRecord } from "./herd-layout.js";
import {
  COMMS_STREAM_MAX,
  type CommsMessage,
  type CommsTelemetryMap,
  applyCommsMessage,
  buildCommsFleet,
  clampFleetSelection,
  commsEdgeLabel,
  commsFleetMeta,
  commsFleetStatLine,
  commsFooterHint,
  commsMessageCard,
  commsRelativeAge,
  commsRowColumns,
  commsStatusLabel,
  commsStatusMarker,
  commsStreamMeta,
  computeCommsEdges,
  computeCommsLayout,
  computeFleetWindow,
  filterMessagesForAgent,
  fleetIndexForNumber,
  formatElapsed,
  formatTokens,
  moveFleetSelection,
} from "./agents-comms-layout.js";

const NOW = 10_000_000;

function record(fields: Partial<HerdSubagentRecord> & { agentId: string }): HerdSubagentRecord {
  return {
    parentScanId: "scan",
    task: "do a thing",
    status: "running",
    maxTurns: 8,
    lastSeen: NOW,
    activity: [],
    ...fields,
  };
}

function mapOf(...records: HerdSubagentRecord[]): HerdSubagentMap {
  const map: HerdSubagentMap = {};
  for (const r of records) map[r.agentId] = r;
  return map;
}

// ---------------------------------------------------------------------------
// Fleet building + ordering
// ---------------------------------------------------------------------------

describe("buildCommsFleet", () => {
  it("skips nothing real and keeps every valid record", () => {
    const fleet = buildCommsFleet(mapOf(record({ agentId: "a" }), record({ agentId: "b" })));
    expect(fleet.map((r) => r.record.agentId)).toEqual(["a", "b"]);
  });

  it("sorts running before queued before terminal, stable within a bucket", () => {
    const fleet = buildCommsFleet(
      mapOf(
        record({ agentId: "done1", status: "completed" }),
        record({ agentId: "run1", status: "running" }),
        record({ agentId: "queued1", status: "queued" }),
        record({ agentId: "run2", status: "running" }),
        record({ agentId: "fail1", status: "failed" }),
      ),
    );
    expect(fleet.map((r) => r.record.agentId)).toEqual(["run1", "run2", "queued1", "fail1", "done1"]);
  });

  it("joins telemetry by agent id", () => {
    const tele: CommsTelemetryMap = { a: { inputTokens: 10, outputTokens: 5 } };
    const fleet = buildCommsFleet(mapOf(record({ agentId: "a" }), record({ agentId: "b" })), tele);
    expect(fleet[0]?.telemetry).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(fleet[1]?.telemetry).toBeUndefined();
  });

  it("keeps the historical status order for sort=\"status\" (the default)", () => {
    const map = mapOf(
      record({ agentId: "done1", status: "completed" }),
      record({ agentId: "run1", status: "running" }),
      record({ agentId: "queued1", status: "queued" }),
      record({ agentId: "fail1", status: "failed" }),
      record({ agentId: "parked1", status: "parked" }),
    );
    expect(buildCommsFleet(map, {}, "status").map((r) => r.record.agentId)).toEqual([
      "run1", "queued1", "parked1", "fail1", "done1",
    ]);
  });

  it("floats failed/parked (needs-operator) to the top for sort=\"attention\"", () => {
    const map = mapOf(
      record({ agentId: "done1", status: "completed" }),
      record({ agentId: "run1", status: "running" }),
      record({ agentId: "queued1", status: "queued" }),
      record({ agentId: "fail1", status: "failed" }),
      record({ agentId: "parked1", status: "parked" }),
    );
    // failed → parked → running → completed → queued (mirrors herd attention).
    expect(buildCommsFleet(map, {}, "attention").map((r) => r.record.agentId)).toEqual([
      "fail1", "parked1", "run1", "done1", "queued1",
    ]);
  });

  it("attention ordering is stable within a bucket", () => {
    const map = mapOf(
      record({ agentId: "f1", status: "failed" }),
      record({ agentId: "r1", status: "running" }),
      record({ agentId: "f2", status: "failed" }),
      record({ agentId: "r2", status: "running" }),
    );
    expect(buildCommsFleet(map, {}, "attention").map((r) => r.record.agentId)).toEqual([
      "f1", "f2", "r1", "r2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Index → agent mapping (number-key jump)
// ---------------------------------------------------------------------------

describe("fleetIndexForNumber — 1-based agent jump", () => {
  it("maps a 1-based number to a 0-based index within range", () => {
    expect(fleetIndexForNumber(5, 1)).toBe(0);
    expect(fleetIndexForNumber(5, 3)).toBe(2);
    expect(fleetIndexForNumber(5, 5)).toBe(4);
  });

  it("returns -1 for out-of-range, zero, negative, non-integer and empty fleets", () => {
    expect(fleetIndexForNumber(5, 6)).toBe(-1);
    expect(fleetIndexForNumber(5, 0)).toBe(-1);
    expect(fleetIndexForNumber(5, -1)).toBe(-1);
    expect(fleetIndexForNumber(5, 2.5)).toBe(-1);
    expect(fleetIndexForNumber(0, 1)).toBe(-1);
    expect(fleetIndexForNumber(Number.NaN, 1)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Truthful stat line — only real fields
// ---------------------------------------------------------------------------

describe("commsFleetStatLine", () => {
  it("shows only the status word when nothing else was reported", () => {
    const [row] = buildCommsFleet(mapOf(record({ agentId: "a", status: "queued" })));
    expect(commsFleetStatLine(row!, NOW)).toBe("queued");
  });

  it("never fabricates tokens or turns", () => {
    const [row] = buildCommsFleet(mapOf(record({ agentId: "a", status: "running" })));
    const line = commsFleetStatLine(row!, NOW);
    expect(line).not.toMatch(/tok/);
    expect(line).not.toMatch(/turn/);
  });

  it("includes turns, tool and findings when present", () => {
    const [row] = buildCommsFleet(
      mapOf(record({ agentId: "a", status: "running", turns: 3, tool: "read_file", findings: 2 })),
    );
    const line = commsFleetStatLine(row!, NOW);
    expect(line).toContain("running");
    expect(line).toContain("3 turns");
    expect(line).toContain("read_file");
    expect(line).toContain("2 findings");
  });

  it("includes measured tokens and elapsed only from telemetry", () => {
    const [row] = buildCommsFleet(
      mapOf(record({ agentId: "a", status: "running" })),
      { a: { inputTokens: 1200, outputTokens: 300, durationMs: 4200 } },
    );
    const line = commsFleetStatLine(row!, NOW);
    expect(line).toContain("1.5k tok");
    expect(line).toContain("4.2s");
  });

  it("does not surface the max-turns budget cap", () => {
    const [row] = buildCommsFleet(mapOf(record({ agentId: "a", status: "running", turns: 3, maxTurns: 25 })));
    expect(commsFleetStatLine(row!, NOW)).not.toContain("25");
  });

  it("reads an operator-stopped worker as stopped, not failed", () => {
    const [row] = buildCommsFleet(mapOf(record({ agentId: "a", status: "failed", operatorStopped: true })));
    expect(commsFleetStatLine(row!, NOW)).toContain("stopped");
    expect(commsFleetStatLine(row!, NOW)).not.toContain("failed");
  });

  it("shows last-seen age only for a settled agent", () => {
    const running = buildCommsFleet(mapOf(record({ agentId: "a", status: "running", lastSeen: NOW - 5000 })))[0]!;
    const done = buildCommsFleet(mapOf(record({ agentId: "b", status: "completed", lastSeen: NOW - 5000 })))[0]!;
    expect(commsFleetStatLine(running, NOW)).not.toContain("5s");
    expect(commsFleetStatLine(done, NOW)).toContain("5s");
  });

  it("appends a curtailed completion reason to the status word", () => {
    const [row] = buildCommsFleet(
      mapOf(record({ agentId: "a", status: "completed", completionReason: "turn_limit" })),
    );
    expect(commsFleetStatLine(row!, NOW).startsWith("done (turn_limit)")).toBe(true);
  });

  it("shows no parenthetical for a clean done", () => {
    const [row] = buildCommsFleet(
      mapOf(record({ agentId: "a", status: "completed", completionReason: "done" })),
    );
    expect(commsFleetStatLine(row!, NOW).startsWith("done")).toBe(true);
    expect(commsFleetStatLine(row!, NOW)).not.toContain("(");
  });

  it("shows live measured tokens/elapsed from the joined telemetry", () => {
    const [row] = buildCommsFleet(
      mapOf(record({ agentId: "a", status: "running" })),
      { a: { inputTokens: 80_000, outputTokens: 48_000, durationMs: 4200 } },
    );
    const line = commsFleetStatLine(row!, NOW);
    expect(line).toContain("128k tok");
    expect(line).toContain("4.2s");
  });
});

describe("format helpers", () => {
  it("formats tokens compactly and omits zero", () => {
    expect(formatTokens(0)).toBe("");
    expect(formatTokens(undefined)).toBe("");
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(42_000)).toBe("42k");
    expect(formatTokens(2_500_000)).toBe("2.5m");
  });

  it("formats elapsed and omits non-positive", () => {
    expect(formatElapsed(0)).toBe("");
    expect(formatElapsed(4200)).toBe("4.2s");
    expect(formatElapsed(63_000)).toBe("1m03s");
    expect(formatElapsed(3_720_000)).toBe("1h02m");
  });

  it("gives relative age with a floor at now", () => {
    expect(commsRelativeAge(NOW, NOW)).toBe("now");
    expect(commsRelativeAge(NOW - 3000, NOW)).toBe("3s");
    expect(commsRelativeAge(NOW - 120_000, NOW)).toBe("2m");
    expect(commsRelativeAge(undefined, NOW)).toBe("");
  });
});

describe("commsStatusLabel / marker", () => {
  it("labels completed as done", () => {
    expect(commsStatusLabel("completed")).toBe("done");
  });
  it("marks an operator-stopped worker distinctly", () => {
    expect(commsStatusMarker(record({ agentId: "a", operatorStopped: true }))).toBe("■");
    expect(commsStatusMarker(record({ agentId: "a", status: "running" }))).toBe("●");
    expect(commsStatusMarker(record({ agentId: "a", status: "failed" }))).toBe("✗");
    expect(commsStatusMarker(record({ agentId: "a", status: "completed" }))).toBe("✓");
  });
});

// ---------------------------------------------------------------------------
// Fleet navigation
// ---------------------------------------------------------------------------

describe("fleet navigation", () => {
  it("clamps into range and reports -1 when empty", () => {
    expect(clampFleetSelection(0, 3)).toBe(-1);
    expect(clampFleetSelection(4, 99)).toBe(3);
    expect(clampFleetSelection(4, -5)).toBe(0);
  });
  it("moves and wraps", () => {
    expect(moveFleetSelection(3, 0, 1)).toBe(1);
    expect(moveFleetSelection(3, 2, 1)).toBe(0);
    expect(moveFleetSelection(3, 0, -1)).toBe(2);
    expect(moveFleetSelection(0, 0, 1)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Message stream reducer
// ---------------------------------------------------------------------------

describe("applyCommsMessage", () => {
  it("appends a well-formed peer message", () => {
    const out = applyCommsMessage([], { from: "Explorer", to: "Main", body: "hi", ts: NOW, kind: "peer" }, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: "Explorer", to: "Main", body: "hi", kind: "peer", seq: 1 });
  });

  it("ignores a malformed payload without a from/to", () => {
    const list: CommsMessage[] = [];
    expect(applyCommsMessage(list, { body: "x" }, 1)).toBe(list);
    expect(applyCommsMessage(list, { from: "A" }, 1)).toBe(list);
  });

  it("carries reply_to when present", () => {
    const out = applyCommsMessage([], { from: "A", to: "B", body: "y", ts: NOW, reply_to: "m1" }, 1);
    expect(out[0]?.replyTo).toBe("m1");
  });

  it("bounds the stream to the tail", () => {
    let list: CommsMessage[] = [];
    for (let i = 0; i < 5; i++) list = applyCommsMessage(list, { from: "A", to: "B", body: `${i}`, ts: NOW }, i, 3);
    expect(list).toHaveLength(3);
    expect(list.map((m) => m.body)).toEqual(["2", "3", "4"]);
  });

  it("defaults COMMS_STREAM_MAX to a bounded cap", () => {
    expect(COMMS_STREAM_MAX).toBeGreaterThan(0);
  });
});

describe("commsMessageCard", () => {
  it("derives a directional card, resolving names", () => {
    const msg: CommsMessage = { seq: 1, from: "x1", to: "Main", body: "hello", ts: NOW - 12_000, kind: "peer" };
    const card = commsMessageCard(msg, { now: NOW, resolveName: (id) => (id === "x1" ? "Explorer" : id) });
    expect(card.from).toBe("Explorer");
    expect(card.direction).toBe("incoming");
    expect(card.age).toBe("12s");
  });
});

describe("filterMessagesForAgent", () => {
  const list: CommsMessage[] = [
    { seq: 1, from: "A", to: "Main", body: "1", ts: NOW },
    { seq: 2, from: "B", to: "C", body: "2", ts: NOW },
    { seq: 3, from: "Main", to: "A", body: "3", ts: NOW },
  ];
  it("keeps only messages touching the agent", () => {
    expect(filterMessagesForAgent(list, "A").map((m) => m.seq)).toEqual([1, 3]);
  });
  it("returns everything for an empty id", () => {
    expect(filterMessagesForAgent(list, "")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Edge counts
// ---------------------------------------------------------------------------

describe("computeCommsEdges", () => {
  it("counts directed pairs and sorts by count desc", () => {
    const list: CommsMessage[] = [
      { seq: 1, from: "A", to: "Main", body: "", ts: NOW },
      { seq: 2, from: "A", to: "Main", body: "", ts: NOW },
      { seq: 3, from: "B", to: "Main", body: "", ts: NOW },
      { seq: 4, from: "Main", to: "A", body: "", ts: NOW },
    ];
    const edges = computeCommsEdges(list);
    expect(edges[0]).toEqual({ from: "A", to: "Main", count: 2 });
    expect(edges).toHaveLength(3);
    expect(commsEdgeLabel(edges[0]!)).toBe("A → Main ×2");
  });
  it("resolves names in the label", () => {
    const edge = { from: "x1", to: "Main", count: 1 };
    expect(commsEdgeLabel(edge, (id) => (id === "x1" ? "Explorer" : id))).toBe("Explorer → Main ×1");
  });
});

// ---------------------------------------------------------------------------
// Row column split — sums to inner width across the sweep
// ---------------------------------------------------------------------------

describe("commsRowColumns", () => {
  it("columns always sum to inner width and never go negative", () => {
    for (let w = 0; w <= 200; w++) {
      const c = commsRowColumns(w);
      const sum = c.markerWidth + c.markerGap + c.nameWidth + c.statGap + c.statWidth;
      expect(sum).toBe(c.width);
      expect(c.width).toBe(Math.max(0, w));
      for (const v of [c.markerWidth, c.markerGap, c.nameWidth, c.statGap, c.statWidth]) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("keeps a name before it affords a stat", () => {
    const narrow = commsRowColumns(12);
    expect(narrow.nameWidth).toBeGreaterThan(0);
    expect(narrow.statWidth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Screen geometry — swept for overflow across widths/heights
// ---------------------------------------------------------------------------

describe("computeCommsLayout", () => {
  it("never lets the regions overflow the body, across the sweep", () => {
    for (let width = 0; width <= 200; width += 7) {
      for (let height = 0; height <= 80; height += 3) {
        for (const showSummary of [false, true]) {
          const layout = computeCommsLayout({
            width,
            height,
            fleetCount: 4,
            showSummary,
            hostRows: 1,
            hostPaddingX: 0,
          });
          const gaps = layout.regionGap * ((layout.summary.height > 0 ? 1 : 0) + (layout.fleet.height > 0 ? 1 : 0));
          const used = layout.fleet.height + layout.summary.height + layout.stream.height + gaps;
          expect(used).toBeLessThanOrEqual(Math.max(0, layout.bodyRows));
          for (const region of [layout.fleet, layout.summary, layout.stream]) {
            expect(region.innerWidth).toBeLessThanOrEqual(layout.contentWidth);
            expect(region.bodyRows).toBeGreaterThanOrEqual(0);
            expect(region.height).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("caps the fleet at half the body and gives the rest to the stream", () => {
    const layout = computeCommsLayout({ width: 100, height: 60, fleetCount: 40, hostRows: 1, hostPaddingX: 0 });
    expect(layout.fleet.height).toBeLessThanOrEqual(Math.ceil(layout.bodyRows * 0.5) + 1);
    expect(layout.stream.height).toBeGreaterThan(0);
  });

  it("drops the summary region on a short body even when asked", () => {
    const layout = computeCommsLayout({ width: 100, height: 16, fleetCount: 3, showSummary: true, hostRows: 1, hostPaddingX: 0 });
    expect(layout.summary.height).toBe(0);
  });

  it("collapses cleanly when nothing fits", () => {
    const layout = computeCommsLayout({ width: 0, height: 0, fleetCount: 3, hostRows: 1, hostPaddingX: 0 });
    expect(layout.fleet.height).toBe(0);
    expect(layout.stream.height).toBe(0);
    expect(layout.fleetVisibleRows).toBe(0);
  });
});

describe("windowing + meta + hints", () => {
  it("windows the fleet without exceeding the visible budget", () => {
    const rows = buildCommsFleet(mapOf(...Array.from({ length: 10 }, (_, i) => record({ agentId: `a${i}` }))));
    const win = computeFleetWindow({ rows, selected: 8, visible: 4, anchor: 0 });
    expect(win.count).toBeLessThanOrEqual(4);
    expect(win.end).toBeLessThanOrEqual(rows.length);
    expect(win.hasBelow || win.end === rows.length).toBe(true);
  });

  it("reports truthful counts", () => {
    expect(commsFleetMeta(0, 0)).toBe("none");
    expect(commsFleetMeta(3, 3)).toBe("3 agents");
    expect(commsFleetMeta(2, 5)).toBe("2/5");
    expect(commsStreamMeta(0, 0, false)).toBe("none");
    expect(commsStreamMeta(4, 4, false)).toBe("4 messages");
    expect(commsStreamMeta(4, 4, true)).toContain("focus");
  });

  it("changes the footer hint when an agent is focused", () => {
    expect(commsFooterHint(false)).toContain("back");
    expect(commsFooterHint(true)).toContain("clear focus");
  });
});
