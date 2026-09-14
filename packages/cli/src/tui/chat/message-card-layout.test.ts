import { describe, expect, it } from "vitest";

import {
  BROADCAST_ID,
  BROADCAST_LABEL,
  GLYPH_INCOMING,
  GLYPH_LEAD,
  GLYPH_OUTGOING,
  type PeerMessageLike,
  boundBodyLines,
  composeHeader,
  deliveryBadgeLabel,
  formatMessageAge,
  headerText,
  messageCardFromPayload,
  messageCardFromPeerEntry,
  messageDirection,
  messageKind,
  metaChips,
  summarizeDelivery,
} from "./message-card-layout.js";

const NOW = 1_000_000;
function msg(fields: Partial<PeerMessageLike>): PeerMessageLike {
  return { from: "Explorer", to: "Main", body: "hello", ts: NOW, ...fields };
}

describe("messageKind", () => {
  it("maps a broadcast recipient to broadcast", () => {
    expect(messageKind(msg({ to: BROADCAST_ID }))).toBe("broadcast");
    expect(messageKind(msg({ to: "Explorer", kind: "broadcast" }))).toBe("broadcast");
  });
  it("honours an explicit operator channel", () => {
    expect(messageKind(msg({ kind: "operator" }))).toBe("operator");
  });
  it("refines a child↔child send to sibling", () => {
    expect(messageKind(msg({ from: "Scanner", to: "Exploiter" }))).toBe("sibling");
  });
  it("keeps a send touching the root console as peer", () => {
    expect(messageKind(msg({ from: "Explorer", to: "Main" }))).toBe("peer");
    expect(messageKind(msg({ from: "Main", to: "Explorer" }))).toBe("peer");
  });
});

describe("messageDirection", () => {
  it("is incoming when addressed to us", () => {
    expect(messageDirection(msg({ to: "Main" }))).toBe("incoming");
  });
  it("is outgoing when sent by us or broadcast", () => {
    expect(messageDirection(msg({ from: "Main", to: "Explorer" }))).toBe("outgoing");
    expect(messageDirection(msg({ from: "Main", to: BROADCAST_ID }))).toBe("outgoing");
  });
  it("is relay between two other agents", () => {
    expect(messageDirection(msg({ from: "Scanner", to: "Exploiter" }))).toBe("relay");
  });
});

describe("composeHeader", () => {
  it("incoming shows the back glyph and the sender only", () => {
    const segs = composeHeader({ from: "Explorer", to: "Main", direction: "incoming" });
    expect(headerText(segs)).toBe(`${GLYPH_LEAD} ${GLYPH_INCOMING} Explorer`);
    expect(segs.find((s) => s.role === "from")?.peerId).toBe("Explorer");
    expect(segs.some((s) => s.role === "to")).toBe(false);
  });
  it("outgoing shows the forward glyph and the recipient only", () => {
    const segs = composeHeader({ from: "Main", to: "Explorer", direction: "outgoing" });
    expect(headerText(segs)).toBe(`${GLYPH_LEAD} ${GLYPH_OUTGOING} Explorer`);
    expect(segs.find((s) => s.role === "to")?.peerId).toBe("Explorer");
  });
  it("relay shows both peers around the arrow", () => {
    const segs = composeHeader({ from: "Scanner", to: "Exploiter", direction: "relay" });
    expect(headerText(segs)).toBe(`${GLYPH_LEAD} Scanner ${GLYPH_OUTGOING} Exploiter`);
    expect(segs.filter((s) => s.role === "from" || s.role === "to").map((s) => s.peerId)).toEqual([
      "Scanner",
      "Exploiter",
    ]);
  });
  it("renders a broadcast recipient as #all with no accent peerId", () => {
    const segs = composeHeader({ from: "Main", to: BROADCAST_ID, direction: "outgoing" });
    expect(headerText(segs)).toBe(`${GLYPH_LEAD} ${GLYPH_OUTGOING} ${BROADCAST_LABEL}`);
    expect(segs.find((s) => s.role === "to")?.peerId).toBeUndefined();
  });
});

describe("metaChips", () => {
  it("orders kind, reply, then age; drops an empty age", () => {
    expect(metaChips({ kind: "sibling", isReply: true, age: "4m" })).toEqual(["sibling", "reply", "4m"]);
    expect(metaChips({ kind: "peer", isReply: false, age: "" })).toEqual(["peer"]);
  });
});

describe("formatMessageAge", () => {
  it("formats seconds, minutes, hours and omits a missing timestamp", () => {
    expect(formatMessageAge(NOW - 5_000, NOW)).toBe("5s");
    expect(formatMessageAge(NOW - 4 * 60_000, NOW)).toBe("4m");
    expect(formatMessageAge(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(formatMessageAge(0, NOW)).toBe("");
    expect(formatMessageAge(undefined, NOW)).toBe("");
  });
});

describe("boundBodyLines", () => {
  it("caps at the collapsed budget and appends an overflow counter", () => {
    const body = ["one", "two", "three", "four", "five"].join("\n");
    const lines = boundBodyLines(body, 40, { expanded: false, collapsedLines: 3 });
    expect(lines.map((l) => l.text)).toEqual(["one", "two", "three", "… +2 more lines"]);
    expect(lines.at(-1)?.kind).toBe("overflow");
  });
  it("shows more when expanded and singularises the counter", () => {
    const body = ["a", "b", "c", "d"].join("\n");
    const collapsed = boundBodyLines(body, 40, { collapsedLines: 3 });
    expect(collapsed.at(-1)?.text).toBe("… +1 more line");
    const expanded = boundBodyLines(body, 40, { expanded: true, expandedLines: 12 });
    expect(expanded.every((l) => l.kind === "body")).toBe(true);
    expect(expanded).toHaveLength(4);
  });
  it("drops blank lines and wraps to width", () => {
    expect(boundBodyLines("\n\n", 40)).toEqual([]);
    const wrapped = boundBodyLines("aaaa bbbb cccc", 4, { collapsedLines: 10 });
    expect(wrapped.map((l) => l.text)).toEqual(["aaaa", "bbbb", "cccc"]);
  });
});

describe("delivery helpers", () => {
  it("labels a receipt and summarises a broadcast", () => {
    expect(deliveryBadgeLabel({ to: "A", ok: true })).toBe("delivered");
    expect(deliveryBadgeLabel({ to: "B", ok: false, reason: "invalid-to" })).toBe("failed: invalid-to");
    expect(summarizeDelivery([{ to: "A", ok: true }, { to: "B", ok: true }, { to: "C", ok: false }])).toBe(
      "2 delivered · 1 failed",
    );
    expect(summarizeDelivery([])).toBe("");
    expect(summarizeDelivery(undefined)).toBe("");
  });
});

describe("messageCardFromPayload", () => {
  it("derives everything and resolves display names", () => {
    const data = messageCardFromPayload(msg({ from: "w1", to: "Main", replyTo: "m0" }), {
      now: NOW,
      resolveName: (id) => (id === "w1" ? "Explorer" : id),
    });
    expect(data.kind).toBe("peer");
    expect(data.direction).toBe("incoming");
    expect(data.from).toBe("Explorer");
    expect(data.to).toBe("Main");
    expect(data.isReply).toBe(true);
    expect(data.chips).toEqual(["peer", "reply", "0s"]);
  });
  it("keeps the broadcast sentinel unresolved", () => {
    const data = messageCardFromPayload(msg({ from: "Main", to: BROADCAST_ID }), { now: NOW });
    expect(data.kind).toBe("broadcast");
    expect(data.to).toBe(BROADCAST_ID);
    expect(data.direction).toBe("outgoing");
  });
});

describe("messageCardFromPeerEntry", () => {
  it("adapts a resolved peer transcript entry", () => {
    const data = messageCardFromPeerEntry(
      { peerFrom: "Scanner", peerTo: "Exploiter", text: "found an open port", at: NOW - 60_000 },
      { now: NOW },
    );
    expect(data.kind).toBe("sibling");
    expect(data.direction).toBe("relay");
    expect(data.from).toBe("Scanner");
    expect(data.body).toBe("found an open port");
    expect(data.age).toBe("1m");
  });
  it("treats a #all recipient as a broadcast and carries delivery", () => {
    const data = messageCardFromPeerEntry(
      { peerFrom: "Main", peerTo: BROADCAST_LABEL, text: "scope update", at: NOW },
      { now: NOW, delivery: [{ to: "Scanner", ok: true }] },
    );
    expect(data.kind).toBe("broadcast");
    expect(data.to).toBe(BROADCAST_ID);
    expect(data.delivery).toHaveLength(1);
  });
});
