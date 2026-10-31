import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
test("transcript retains chronological text/tool boundaries in live, saved and partial journals", async () => {
  const directory = await mkdtemp(resolve(root, "packages/dashboard/.transcript-order-test-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ entryPoints: [resolve(root, "packages/dashboard/src/console/transcript.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { reduceTurns, reduceConversation } = await import(pathToFileURL(output).href);
    const call = id => ({ id, name: "read_file", arguments: { path: `${id}.ts` } });
    const event = (type, sequence, rest = {}) => ({ type, sequence, ...rest });
    const budget = { tokensUsed: 10, tokenBudget: null, iterations: 2, maxToolIterations: null };
    const events = [
      event("user", 1, { text: "Review" }),
      event("assistant-delta", 2, { text: "First " }),
      event("assistant-delta", 3, { text: "pass." }),
      event("reasoning-delta", 4, { text: "Check source" }),
      event("tool-start", 5, { call: call("a") }),
      event("tool-result", 6, { call: call("a"), result: "Source A" }),
      event("assistant-delta", 7, { text: "Next." }),
      event("tool-start", 8, { call: call("b") }),
      event("tool-result", 9, { call: call("b"), result: "Source B" }),
      event("assistant-delta", 10, { text: "Done." }),
    ];
    const shape = turn => turn.segments.map(segment => segment.type === "tools" ? [segment.type, segment.toolIds] : [segment.type, segment.text]);
    const live = reduceTurns(events, "working")[0];
    assert.deepEqual(shape(live), [["assistant", "First pass."], ["reasoning", "Check source"], ["tools", ["a"]], ["assistant", "Next."], ["tools", ["b"]], ["assistant", "Done."]]);
    assert.equal(live.toolCalls[0].result, "Source A");
    assert.equal(live.toolCalls[0].isRunning, false, "results update the existing chronological group");
    const outcome = { assistantText: "First pass.Next.Done.", stopReason: "end_turn", budget };
    const complete = reduceTurns([...events, event("turn-complete", 11, outcome)], "ready")[0];
    assert.deepEqual(shape(complete), shape(live), "authoritative final aggregate does not duplicate or move commentary");

    const text = text => ({ type: "text", text });
    const use = id => ({ type: "tool_use", id, name: "read_file", input: { path: `${id}.ts` } });
    const result = id => ({ type: "tool_result", tool_use_id: id, content: `Source ${id.toUpperCase()}` });
    const messages = [
      { role: "user", content: [text("Review")] },
      { role: "assistant", content: [text("First pass."), use("a")] },
      { role: "user", content: [result("a")] },
      { role: "assistant", content: [text("Next."), use("b")] },
      { role: "user", content: [result("b")] },
      { role: "assistant", content: [text("Done.")] },
    ];
    const snapshot = { session: { status: "ready" }, messages, events: [], pendingDecisions: [], lastOutcome: outcome, cursor: 11 };
    assert.deepEqual(shape(reduceConversation(snapshot)[0]), [["assistant", "First pass."], ["tools", ["a"]], ["assistant", "Next."], ["tools", ["b"]], ["assistant", "Done."]]);
    const merged = reduceConversation({ ...snapshot, events })[0];
    assert.deepEqual(shape(merged), shape(complete), "saved calls and full journal preserve one chronological copy");
    assert.equal(merged.toolCalls.length, 2);

    const truncated = reduceConversation({ ...snapshot, events: events.slice(5) })[0];
    assert.deepEqual(shape(truncated), [["assistant", "First pass."], ["tools", ["a"]], ["assistant", "Next."], ["tools", ["b"]], ["assistant", "Done."]], "a truncated journal updates anchored groups without replaying committed text");
    const partialMessages = messages.slice(0, 3);
    const growing = reduceConversation({ ...snapshot, session: { status: "working" }, messages: partialMessages, events: events.slice(5), lastOutcome: null })[0];
    assert.deepEqual(shape(growing), [["assistant", "First pass."], ["tools", ["a"]], ["assistant", "Next."], ["tools", ["b"]], ["assistant", "Done."]], "new live groups append after their committed history anchor");
    const repeated = ["provider-a", "provider-b"].map(id => ({ type: "tool_use", id, name: "read_file", input: { path: "same.ts" } }));
    const latestCall = { id: "gateway-b", name: "read_file", arguments: { path: "same.ts" } };
    const repeatedTurn = reduceConversation({ ...snapshot, lastOutcome: null, messages: [messages[0], { role: "assistant", content: repeated }], events: [event("tool-start", 5, { call: latestCall }), event("tool-result", 6, { call: latestCall, result: "Latest result" })] })[0];
    assert.deepEqual(shape(repeatedTurn), [["tools", ["provider-a", "provider-b"]]], "gateway IDs resolve to existing provider call groups without orphan duplicates");
    assert.equal(repeatedTurn.toolCalls[0].result, undefined);
    assert.equal(repeatedTurn.toolCalls[1].result, "Latest result", "a partial repeated call maps to its latest occurrence");
    // Sanitized reproduction of the real provider run: callbacks retained every
    // tool, but text was supplied only as one final aggregate, never as deltas.
    const toolOnlyEvents = events.filter(item => !["assistant-delta", "reasoning-delta"].includes(item.type));
    const receiptOnly = reduceConversation({ ...snapshot, events: [...toolOnlyEvents, event("turn-complete", 11, outcome)] })[0];
    assert.deepEqual(shape(receiptOnly), shape(reduceConversation(snapshot)[0]), "a final aggregate cannot replace richer native message chronology");
    const separatedOutcome = { ...outcome, assistantText: "First pass.\n\nNext.\n\nDone." };
    const separated = reduceConversation({ ...snapshot, events: [...toolOnlyEvents, event("turn-complete", 11, separatedOutcome)], lastOutcome: separatedOutcome })[0];
    assert.deepEqual(shape(separated), [["assistant", "First pass."], ["tools", ["a"]], ["assistant", "\n\nNext."], ["tools", ["b"]], ["assistant", "\n\nDone."]], "exact source blocks retain their positions when the final aggregate adds separators");
    assert.equal(separated.segments.filter(segment => segment.type === "assistant").map(segment => segment.text).join(""), separatedOutcome.assistantText);
    const cleared = reduceTurns([...events, event("turn-complete", 11, { ...outcome, assistantText: "" })], "ready")[0];
    assert.ok(cleared.segments.every(segment => segment.type !== "assistant"), "an intentionally empty authoritative response clears streamed text");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
