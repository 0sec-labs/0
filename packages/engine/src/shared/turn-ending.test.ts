import { describe, expect, it } from "vitest";
import { turnEndingKind } from "./desktop-console.js";

describe("turnEndingKind", () => {
  it.each([
    ["an empty stop", { stopReason: "end_turn", assistantText: "" }, "no_reply"],
    ["whitespace only", { stopReason: "end_turn", assistantText: " \n" }, "no_reply"],
    ["a restored turn with no recorded reason", { assistantText: "" }, "no_reply"],
    ["a cut-off reply", { stopReason: "output_cap", assistantText: "Here is a partial answ" }, "truncated"],
    ["a content filter", { stopReason: "error", assistantText: "", error: "OpenAI-compatible API error: Provider finish_reason: content_filter" }, "filtered"],
    ["a socket closed before any token", { stopReason: "error", assistantText: "", error: "OpenAI-compatible API error: terminated: other side closed (UND_ERR_SOCKET)" }, "disconnected"],
    ["a 200 with no choices", { stopReason: "error", assistantText: "", error: "OpenAI-compatible API error: Stream ended without finish_reason" }, "no_reply"],
    ["a stream that ends mid-text", { stopReason: "error", assistantText: "Partial", error: "Stream ended without finish_reason" }, "disconnected"],
    ["every tool failing and no text", { stopReason: "end_turn", assistantText: "", silentWork: false }, "no_reply"],
  ] as const)("reports %s", (_name, turn, kind) => {
    expect(turnEndingKind(turn)).toBe(kind);
  });

  it.each([
    ["a normal answer", { stopReason: "end_turn", assistantText: "Done." }],
    ["a silent finish after working tools", { stopReason: "end_turn", assistantText: "", silentWork: true }],
    ["an operator stop", { stopReason: "cancelled", assistantText: "" }],
    ["a stop with a generic error", { stopReason: "cancelled", assistantText: "", error: "Workbench cancelled" }],
    ["a rejected key", { stopReason: "error", assistantText: "", error: "401 Unauthorized: invalid api key" }],
    ["a token budget stop", { stopReason: "max_turn_tokens", assistantText: "" }],
    ["a legacy checkpoint that has its own control", { stopReason: "output_cap", assistantText: "x", outputCap: { checkpoint: {} } }],
  ] as const)("leaves %s alone", (_name, turn) => {
    expect(turnEndingKind(turn)).toBeUndefined();
  });
});
