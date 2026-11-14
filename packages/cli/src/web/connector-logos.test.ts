import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_PLUGIN_CATALOG } from "@0/engine/shared";
import { IconCache, connectorLogo, fetchMarketplaceIcon, monogramLogo, sanitizeIcon } from "./connector-logos.js";
import { BRAND_LOGOS } from "./connector-logo-data.generated.js";

function png(width: number, height: number, extra = 0): Buffer {
  const buffer = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write("IHDR", 12, "ascii"); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}
const decode = (uri: string) => Buffer.from(uri.split(",")[1]!, "base64").toString("utf8");

describe("connector logos", () => {
  it("generates escaped monograms as same-origin data URIs", () => {
    const uri = monogramLogo("github", "GitHub");
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(decode(uri)).toContain("#24292f");
    const hostile = decode(monogramLogo("x", '<script>alert(1)</script>"'));
    expect(hostile).not.toContain("<script");
  });
  it("gives every built-in connector a safe logo and uses real marks where simple-icons has them", () => {
    const monogramOnly = new Set(["slack", "teams"]);
    for (const plugin of SERVICE_PLUGIN_CATALOG) {
      const uri = connectorLogo(plugin.id, plugin.name);
      expect(uri, plugin.id).toMatch(/^data:image\/svg\+xml;base64,/);
      const text = decode(uri);
      expect(text, plugin.id).toContain(monogramOnly.has(plugin.id) ? "<text" : "<path");
    }
    expect(connectorLogo("unknown-thing", "Unknown")).toBe(monogramLogo("unknown-thing", "Unknown"));
    expect(connectorLogo("__proto__", "x")).toBe(monogramLogo("__proto__", "x"));
  });
  it("only embeds safe generated brand data", () => {
    for (const [id, logo] of Object.entries(BRAND_LOGOS)) {
      const text = decode(connectorLogo(id, logo.title));
      expect(logo.hex).toMatch(/^[0-9A-Fa-f]{6}$/);
      for (const d of logo.paths ?? [logo.path]) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9eE .,+-]+$/);
      expect(text, id).not.toMatch(/<script|href|xlink|url\(|data:|<image|<foreignObject|\son[a-z]+=/i);
      expect(sanitizeIcon(Buffer.from(text)), id).toMatch(/^data:image\/svg\+xml/);
    }
  });
  it("accepts small PNGs and rejects oversized or malformed ones", () => {
    expect(sanitizeIcon(png(64, 64))).toMatch(/^data:image\/png;base64,/);
    expect(sanitizeIcon(png(1024, 64))).toBeNull();
    expect(sanitizeIcon(png(64, 64, 40_000))).toBeNull();
    expect(sanitizeIcon(Buffer.from("GIF89a....."))).toBeNull();
  });
  it("sanitises SVG by allow-list", () => {
    expect(sanitizeIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z" fill="#123"/></svg>'))).toMatch(/^data:image\/svg\+xml/);
    for (const bad of [
      '<svg><script>alert(1)</script></svg>', '<svg onload="x()"><path d="M0 0"/></svg>', '<svg><foreignObject/></svg>',
      '<svg><image href="https://evil.example/x.png"/></svg>', '<svg><a xlink:href="javascript:x"><path/></a></svg>',
      '<svg><path style="fill:url(https://evil.example/x)"/></svg>', '<!DOCTYPE svg [<!ENTITY x "y">]><svg><path/></svg>', '<svg><use href="#a"/></svg>', '<html><svg></svg></html>',
    ]) expect(sanitizeIcon(Buffer.from(bad)), bad).toBeNull();
  });
  it("fetches only public https icons, without redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(png(32, 32))));
    expect(await fetchMarketplaceIcon("http://cdn.example/i.png", { fetchImpl, resolve: async () => ["93.184.216.34"] })).toBeNull();
    expect(await fetchMarketplaceIcon("https://127.0.0.1/i.png", { fetchImpl })).toBeNull();
    expect(await fetchMarketplaceIcon("https://cdn.example/i.png", { fetchImpl, resolve: async () => ["10.0.0.1"] })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await fetchMarketplaceIcon("https://cdn.example/i.png", { fetchImpl, resolve: async () => ["93.184.216.34"] })).toMatch(/^data:image\/png/);
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "error" }));
  });
  describe("cache", () => {
    let home: string;
    afterEach(() => rmSync(home, { recursive: true, force: true }));
    it("serves a monogram first, then the cached validated icon, persisted across instances", async () => {
      home = mkdtempSync(join(tmpdir(), "zero-icons-"));
      const fetchImpl = vi.fn(async () => new Response(new Uint8Array(png(48, 48))));
      const cache = new IconCache({ homeDir: home, fetchImpl, resolve: async () => ["93.184.216.34"] });
      expect(cache.logoFor("p", "Plugin", "https://cdn.example/p.png")).toMatch(/^data:image\/svg\+xml/);
      await cache.idle();
      expect(cache.logoFor("p", "Plugin", "https://cdn.example/p.png")).toMatch(/^data:image\/png/);
      expect(new IconCache({ homeDir: home }).logoFor("p", "Plugin", "https://cdn.example/p.png")).toMatch(/^data:image\/png/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it("never caches rejected icons", async () => {
      home = mkdtempSync(join(tmpdir(), "zero-icons-"));
      const cache = new IconCache({ homeDir: home, fetchImpl: async () => new Response("<svg><script/></svg>"), resolve: async () => ["93.184.216.34"] });
      cache.logoFor("p", "Plugin", "https://cdn.example/p.svg"); await cache.idle();
      expect(cache.logoFor("p", "Plugin", "https://cdn.example/p.svg")).toMatch(/^data:image\/svg\+xml/);
      expect(decodeURIComponent(escape(decode(cache.logoFor("p", "Plugin", "https://cdn.example/p.svg"))))).toContain("<text");
    });
  });
});
