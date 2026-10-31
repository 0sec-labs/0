import { expect, test, vi } from "vitest";
vi.mock("@/api", () => ({ useBackendApi: () => ({}) }));
import { browserStreamParser, browserViews, MAX_BROWSER_STREAM_BUFFER, type BrowserStreamMessage } from "../../../dashboard/src/console/use-browser-live";

const frame = { data: "aGVsbG8=", mimeType: "image/jpeg", capturedAt: "2026-10-20T08:00:00Z", width: 960, height: 600 };
test("decodes split CRLF event boundaries and multiple frames without dropping chunks", () => {
  const events: BrowserStreamMessage[] = [];
  const parse = browserStreamParser(message => events.push(message));
  const wire = `event: state\r\ndata: {"status":"connecting"}\r\n\r\nevent: frame\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`;
  for (let offset = 0; offset < wire.length; offset += 3) parse(wire.slice(offset, offset + 3));
  expect(events.map(message => message.type)).toEqual(["state", "frame"]);
  expect(events[1]).toEqual({ type: "frame", frame: { src: "data:image/jpeg;base64,aGVsbG8=", capturedAt: frame.capturedAt, width: 960, height: 600 } });
});
test("ignores malformed/unsafe payloads while continuing with later valid frames", () => {
  const events: BrowserStreamMessage[] = [];
  const parse = browserStreamParser(message => events.push(message));
  parse(`event: frame\ndata: not json\n\nevent: frame\ndata: null\n\n`);
  for (const invalid of [{ ...frame, mimeType: "image/svg+xml" }, { ...frame, data: "<script>" }, { ...frame, capturedAt: "invalid" }]) parse(`event: frame\ndata: ${JSON.stringify(invalid)}\n\n`);
  parse(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
  expect(events).toHaveLength(1);
});
test("rejects oversized partial and completed events; reconnect parser starts clean", () => {
  const parse = browserStreamParser(() => {});
  expect(() => parse("x".repeat(MAX_BROWSER_STREAM_BUFFER + 1))).toThrow(/size limit/);
  expect(() => browserStreamParser(() => {})("x".repeat(MAX_BROWSER_STREAM_BUFFER + 1) + "\n\n")).toThrow(/size limit/);
  const events: BrowserStreamMessage[] = [];
  const previousConnection = browserStreamParser(() => {});
  previousConnection("event: frame\ndata: {\"data\":");
  const reconnected = browserStreamParser(message => events.push(message));
  reconnected(`event: state\ndata: {"status":"live"}\n\nevent: frame\ndata: ${JSON.stringify(frame)}\n\n`);
  expect(events.map(message => message.type)).toEqual(["state", "frame"]);
});
test("registry accepts driver session UUID distinct from owning console session, validates fields and bounds views", () => {
  const view = { id: "page", pageId: "page", sessionId: "driver-uuid", producerId: "worker", tab: "main", url: "https://example.com", liveAvailable: true };
  expect(browserViews({ views: [view] }, "console-chat")).toEqual([view]);
  expect(browserViews({ views: [null, { ...view, pageId: "" }, { ...view, producerId: 7 }] })).toEqual([]);
  expect(browserViews({ views: Array.from({ length: 20 }, (_, index) => ({ ...view, id: String(index), pageId: String(index) })) })).toHaveLength(12);
});
