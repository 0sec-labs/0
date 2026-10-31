import { describe, expect, it } from "vitest";
import { parseDuckDuckGoResults, readWebSearchResponse } from "./web-search-response.js";

describe("DuckDuckGo HTML fixtures", () => {
  it("accepts attribute reordering, class lists, entities and optional snippets", () => {
    const html = `<a href='https://example.test/docs?a=1&amp;b=2' class='extra result__a'>A &amp; B &#x1f50e;</a><div class='result__snippet'>Read <b>the</b> docs &quot;now&quot;.</div><a href="https://other.test/" class="result__a">Other</a>`;
    expect(parseDuckDuckGoResults(html)).toEqual({ ok: true, results: [
      { title: "A & B 🔎", url: "https://example.test/docs?a=1&b=2", snippet: 'Read the docs "now".' },
      { title: "Other", url: "https://other.test/", snippet: "" },
    ] });
  });
  it("decodes redirect destinations once and preserves encoded target paths", () => {
    const target = "https://example.test/a%2Fb?q=x%26y";
    expect(parseDuckDuckGoResults(`<a href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=abc" class="result__a">Result</a>`)).toEqual({ ok: true, results: [{ title: "Result", url: target, snippet: "" }] });
  });
  it("does not reinterpret another site's uddg parameter or expose unsafe URLs", () => {
    const html = `<a class="result__a" href="javascript:alert(1)">Bad</a><a class="result__a" href="https://user:pass@example.test/">Private</a><a class="result__a" href="https://example.test/?uddg=other">Real</a>`;
    expect(parseDuckDuckGoResults(html)).toEqual({ ok: true, results: [{ title: "Real", url: "https://example.test/?uddg=other", snippet: "" }] });
  });
  it("distinguishes genuine empty results, verification challenges and markup changes", () => {
    expect(parseDuckDuckGoResults('<div class="no-results__message">No results found for query</div>')).toEqual({ ok: true, results: [] });
    expect(parseDuckDuckGoResults('<form id="challenge-form">Pick the ducks</form>')).toMatchObject({ ok: false, error: expect.stringContaining("verification challenge") });
    expect(parseDuckDuckGoResults('<html><p>Changed or temporarily unavailable</p></html>')).toMatchObject({ ok: false, error: expect.stringContaining("unrecognized") });
    expect(parseDuckDuckGoResults('<html>Service down. Query: No results found for cats</html>')).toMatchObject({ ok: false });
  });
  it("bounds normalized text and rejects missing or oversized destinations", () => {
    const result = parseDuckDuckGoResults(`<a class="result__a">Missing href</a><a class="result__a" href="https://example.test/${"a".repeat(5000)}">Too long</a><a class="result__a" href="https://example.test/">${"t".repeat(2000)}</a><span class="result__snippet">${"s".repeat(10000)}</span>`);
    expect(result.ok && result.results).toEqual([{ title: "t".repeat(300), url: "https://example.test/", snippet: "s".repeat(1000) }]);
  });
  it("deduplicates links and bounds the result set", () => {
    const result = parseDuckDuckGoResults(Array.from({ length: 20 }, (_, i) => `<a class="result__a" href="https://example.test/${Math.floor(i / 2)}">Result ${i}</a>`).join(""));
    expect(result.ok && result.results).toHaveLength(5);
  });
});
describe("bounded search response consumption", () => {
  it("keeps cancellation effective after successful response headers", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const pending = readWebSearchResponse(new Response(body), controller.signal);
    const rejection = expect(pending).rejects.toThrow();
    controller.abort();
    await rejection;
    expect(cancelled).toBe(true);
  });
  it("rejects oversized bodies instead of parsing a truncated page as empty", async () => {
    await expect(readWebSearchResponse(new Response("x".repeat(1_000_001)), new AbortController().signal)).rejects.toThrow("size limit");
  });
});
