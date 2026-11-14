import type { ConsoleSessionSnapshot, DesktopConsoleToolCall } from "@0/engine/shared";
import { imageSource, toolImages } from "./inline-image";

export interface BrowserPreview {
  id: string;
  viewId: string;
  src: string;
  title: string;
  url?: string;
  owner: string;
  capturedAt: number;
  pageId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Latest actual browser captures per tab and owner, never a simulated live view. */
export function browserPreviews(snapshot: ConsoleSessionSnapshot): BrowserPreview[] {
  const captures: BrowserPreview[] = [];
  function collect(call: DesktopConsoleToolCall, result: unknown, ownerId: string, owner: string, id: string, capturedAt: number) {
    // Image generation and unrelated tool images belong in the transcript only.
    if (!/browser|playwright|puppeteer|computer|cua|screenshot/i.test(call.name)) return;
    let decoded = result;
    if (typeof result === "string") {
      try { decoded = JSON.parse(result); } catch { return; }
    }
    const receipt = record(decoded);
    const output = record(receipt.output);
    const args = record(call.arguments);
    const browser = record(record(receipt.meta).browser);
    const url = text(browser.url) || text(output.url) || text(args.url);
    const tab = text(browser.tab) || text(output.tab) || text(output.tabId) || text(args.tab) || text(args.tabId);
    let hostname: string | undefined;
    try { hostname = url ? new URL(url).hostname : undefined; } catch { /* A capture can lack URL metadata. */ }
    const title = text(browser.title) || text(output.title) || text(output.screenshot_caption) || hostname || "Browser capture";
    toolImages(decoded).forEach((image, index) => {
      const safe = imageSource(image.src);
      if (!safe || !safe.startsWith("data:image/")) return;
      captures.push({
      id: `${ownerId}:${id}:${index}`,
      viewId: `${ownerId}:${tab || url || "browser"}:${index}`,
      src: safe,
      title,
      url,
      owner,
      capturedAt,
      pageId: text(browser.pageId) || text(record(receipt.meta).browserPageId) || text(output.browserPageId) || text(output.pageId),
      });
    });
  }
  for (const event of snapshot.events) {
    if (event.type === "tool-result") collect(event.call, event.result, "main", "Main chat", String(event.sequence), Date.parse(event.occurredAt) || 0);
  }
  for (const worker of snapshot.workers) {
    for (const turn of worker.transcript) {
      for (const tool of turn.tools || []) {
        collect(tool.call, tool.result, worker.id, worker.name, `${turn.turn}:${tool.callIndex}:${tool.call.id || ""}`, turn.ts);
      }
    }
  }
  const latest = new Map<string, BrowserPreview>();
  for (const capture of captures.sort((a, b) => a.capturedAt - b.capturedAt)) latest.set(capture.viewId, capture);
  return [...latest.values()].sort((a, b) => b.capturedAt - a.capturedAt).slice(0, 6);
}
