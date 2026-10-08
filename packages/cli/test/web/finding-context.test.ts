import { expect, test } from "vitest";
import { addFindingToDraft, existingFindingsForChat, findingsForChat } from "../../../dashboard/src/console/finding-context";
import type { FindingGroup, FindingRecord } from "../../../dashboard/src/types";

const finding = (id: string, scanId: string, timestamp = 1): FindingRecord => ({
  id, scanId, timestamp, title: "Authorization gap", description: "Stored evidence",
  severity: "high", category: "authorization", status: "unverified", triageStatus: "new",
  evidenceRequest: "", evidenceResponse: "",
});
const group = (latest: FindingRecord) => ({ fingerprint: latest.id, latest } as FindingGroup);

test("adding findings keeps the draft and distinct evidence references without duplicate context", () => {
  const first = finding("finding-1", "chat-1");
  const draft = addFindingToDraft("Keep my existing question.", first);
  expect(draft).toContain("Keep my existing question.");
  expect(draft).toContain("Saved finding: finding-1 (scan: chat-1)");
  expect(draft).toContain('"status":"unverified"');
  expect(addFindingToDraft(draft, first)).toBe(draft);
  expect(addFindingToDraft(draft, finding("finding-2", "chat-1"))).toContain("Saved finding: finding-2");
});

test("automatic chat findings use conversation identity, never a matching target or title", () => {
  const own = group(finding("own", "live-chat", 2));
  const resumed = group(finding("saved", "original-chat", 3));
  const unrelated = group(finding("other", "other-chat", 4));
  const suppressed = group({ ...finding("suppressed", "live-chat"), triageStatus: "suppressed" });
  const groups = [own, unrelated, resumed, suppressed];
  expect(findingsForChat(groups, "live-chat", "original-chat").map(item => item.latest.id)).toEqual(["saved", "own"]);
  expect(findingsForChat(groups, "other-chat").map(item => item.latest.id)).toEqual(["other"]);
  expect(groups[0]).toBe(own);
});

test("explicit finding picker includes other sources while excluding own and suppressed findings", () => {
  const groups = [
    group(finding("own", "live-chat", 9)),
    group(finding("saved", "saved-chat", 8)),
    group(finding("older", "source-scan", 1)),
    group({ ...finding("hidden", "other-chat", 7), triageStatus: "suppressed" }),
    group(finding("newer", "other-chat", 3)),
  ];
  expect(existingFindingsForChat(groups, "live-chat", "saved-chat").map(item => item.latest.id)).toEqual(["newer", "older"]);
  expect(groups.map(item => item.latest.id)).toEqual(["own", "saved", "older", "hidden", "newer"]);
  expect(findingsForChat(groups, "live-chat", "saved-chat").map(item => item.latest.id)).toEqual(["own", "saved"]);
});

test("existing finding search matches title, severity, source and ID with all search terms", () => {
  const groups = [group(finding("finding-1", "review-repo")), group({ ...finding("finding-2", "web-scan"), title: "SQL injection", severity: "critical" })];
  expect(existingFindingsForChat(groups, "current", undefined, " HIGH authorization ").map(item => item.latest.id)).toEqual(["finding-1"]);
  expect(existingFindingsForChat(groups, "current", undefined, "web-scan critical").map(item => item.latest.id)).toEqual(["finding-2"]);
  expect(existingFindingsForChat(groups, "current", undefined, "finding-2")).toHaveLength(1);
  expect(existingFindingsForChat(groups, "current", undefined, "web-scan high")).toEqual([]);
});

test("attaching another chat's finding preserves the draft and uses an evidence reference once", () => {
  const selected = existingFindingsForChat([group(finding("external", "other-chat"))], "current")[0]!.latest;
  const draft = addFindingToDraft("Compare this with the current investigation.", selected);
  expect(draft).toContain("Compare this with the current investigation.");
  expect(draft).toContain("Saved finding: external (scan: other-chat)");
  expect(draft).toContain("Inspect the stored finding and its evidence");
  expect(addFindingToDraft(draft, selected)).toBe(draft);
  expect(draft).not.toContain(selected.description);
});
