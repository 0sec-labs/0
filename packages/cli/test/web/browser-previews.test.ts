import { expect, test, vi } from "vitest";
import type { ConsoleSessionSnapshot, DesktopConsoleEvent } from "@0/shared";

// Rendering is covered by the browser; this suite exercises capture selection.
vi.mock("@/api", () => ({ useBackendApi: () => ({}) }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: null, DialogContent: null, DialogTitle: null, DialogTrigger: null }));
import { browserPreviews } from "../../../dashboard/src/console/browser-previews";

const image = (base64 = "aGVsbG8=") => ({ output: { tab: "tab-a", url: "https://example.com", title: "Example" }, meta: { image: { mimeType: "image/png", imageBase64: base64 } } });
function event(sequence: number, result: unknown, name = "browser"): DesktopConsoleEvent {
  return { type: "tool-result", schemaVersion: 1, sessionId: "chat", sequence, occurredAt: new Date(sequence * 1000).toISOString(), call: { name, arguments: {} }, result };
}
function snapshot(events: DesktopConsoleEvent[], workers: ConsoleSessionSnapshot["workers"] = []): ConsoleSessionSnapshot {
  return { events, workers } as unknown as ConsoleSessionSnapshot;
}

test("keeps the newest capture per browser tab and keeps worker views independent", () => {
  const state = snapshot([event(1, image()), event(3, image("d29ybGQ="))], [{
    id: "worker-a", parentId: "chat", name: "Research", status: "running", task: "Review site",
    transcript: [{ turn: 1, ts: 4000, tools: [{ callIndex: 0, call: { name: "browser", arguments: {} }, result: image() }] }],
  }]);
  const previews = browserPreviews(state);
  expect(previews).toHaveLength(2);
  expect(previews.map(capture => capture.owner)).toEqual(["Research", "Main conversation"]);
  expect(previews[1]?.src).toBe("data:image/png;base64,d29ybGQ=");
});

test("excludes unrelated image tools and accepts serialized browser MCP image content", () => {
  const previews = browserPreviews(snapshot([
    event(1, image(), "image_generate"),
    event(2, JSON.stringify({ content: [{ type: "image", mimeType: "image/webp", data: "aGVsbG8=" }] }), "mcp__browser__screenshot"),
  ]));
  expect(previews).toHaveLength(1);
  expect(previews[0]?.src).toBe("data:image/webp;base64,aGVsbG8=");
});

test("ignores malformed, unsupported and invalid image payloads without throwing", () => {
  const invalid = [null, "not json", {}, { meta: { image: { mimeType: "image/svg+xml", imageBase64: "aGVsbG8=" } } }, image("<script>"), { content: [null, { type: "image", data: 42 }] }];
  expect(browserPreviews(snapshot(invalid.map((result, index) => event(index + 1, result))))).toEqual([]);
});

test("bounds the rail to the six newest distinct browser views", () => {
  const events = Array.from({ length: 9 }, (_, index) => event(index + 1, { ...image(), output: { tab: `tab-${index}` } }));
  const previews = browserPreviews(snapshot(events));
  expect(previews).toHaveLength(6);
  expect(previews.map(capture => capture.capturedAt)).toEqual([9000, 8000, 7000, 6000, 5000, 4000]);
});
