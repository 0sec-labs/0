import { expect, test } from "vitest";
import { addFindingToDraft, findingsForChat } from "../../../dashboard/src/console/finding-context";
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
