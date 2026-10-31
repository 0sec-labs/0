/** Small bounded parser for DuckDuckGo's HTML results, never a general HTML interpreter. */
export interface WebSearchResult { title: string; url: string; snippet: string }
const MAX_SEARCH_BYTES = 1_000_000;

function entities(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
    const number = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "�";
  });
}
function text(html: string): string { return entities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
function attributes(html: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const match of html.matchAll(/([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) values[match[1]!.toLowerCase()] = entities(match[2] ?? match[3] ?? match[4] ?? "");
  return values;
}
function hasClass(attrs: Record<string, string>, name: string): boolean { return (attrs.class ?? "").split(/\s+/).includes(name); }
function snippet(html: string): string {
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    if (!hasClass(attributes(match[2]!), "result__snippet")) continue;
    const after = html.slice(match.index! + match[0].length);
    return text(after.split(new RegExp(`</${match[1]}>`, "i"), 1)[0] ?? "").slice(0, 1000);
  }
  return "";
}
function destination(raw: string): string | undefined {
  try {
    if (!raw.trim() || raw.length > 4096) return undefined;
    let url = new URL(raw, "https://duckduckgo.com");
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
      const target = url.searchParams.get("uddg");
      if (target) url = new URL(target); // URLSearchParams already decoded it once.
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /[\u0000-\u001f\u007f]/.test(url.href)) return undefined;
    return url.href.length <= 4096 ? url.href : undefined;
  } catch { return undefined; }
}
export function parseDuckDuckGoResults(html: string): { ok: true; results: WebSearchResult[] } | { ok: false; error: string } {
  if (/\b(?:id|name)\s*=\s*["'](?:challenge-form|anomaly-form)["']|\bclass\s*=\s*["'][^"']*\banomaly-modal\b|anomaly\.js\?/i.test(html)) {
    return { ok: false, error: "Search provider requires a verification challenge. Retry later." };
  }
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(match => hasClass(attributes(match[1]!), "result__a"));
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < anchors.length && results.length < 5; index++) {
    const anchor = anchors[index]!;
    const url = destination(attributes(anchor[1]!).href ?? "");
    const title = text(anchor[2]!).slice(0, 300);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const after = anchor.index! + anchor[0].length;
    results.push({ title, url, snippet: snippet(html.slice(after, anchors[index + 1]?.index ?? html.length)) });
  }
  if (results.length) return { ok: true, results };
  if (/\bclass\s*=\s*["'][^"']*\bno-results(?:__message)?\b/i.test(html)) return { ok: true, results: [] };
  return { ok: false, error: "Search provider returned an unrecognized results page. Retry later." };
}

/** Keep the request deadline through body consumption, including uncooperative readers. */
export async function readWebSearchResponse(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => { void reader.cancel().catch(() => {}); reject(new Error("Search response timed out or was cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (next.done) return Buffer.concat(chunks, bytes).toString("utf8");
      bytes += next.value.length;
      if (bytes > MAX_SEARCH_BYTES) throw new Error("Search response exceeds the size limit.");
      chunks.push(next.value);
    }
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
