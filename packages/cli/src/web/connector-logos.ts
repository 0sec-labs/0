import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "@0/engine/shared";
import { isPrivateAddress } from "@0/engine";

/**
 * Logos are always same-origin data URIs (CSP: img-src 'self' data: blob:).
 * No third-party brand artwork is bundled; known connectors get a stable,
 * brand-leaning monogram and fetched marketplace icons are validated + cached.
 */
const BRAND_COLORS: Readonly<Record<string, string>> = {
  github: "#24292f", elastic: "#0b64dd", semgrep: "#1b9e77", snyk: "#4c4a73", linear: "#5e6ad2",
  jira: "#0052cc", cloudflare: "#f38020", slack: "#4a154b", teams: "#5059c9",
};
const MAX_ICON_BYTES = 32 * 1024;
const MAX_ICON_DIMENSION = 256;
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon", "defs", "lineargradient", "radialgradient", "stop", "title", "desc", "clippath"]);

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
function colorFor(id: string): string {
  const known = BRAND_COLORS[id];
  if (known) return known;
  const hue = createHash("sha256").update(id).digest()[0]! * 360 / 256;
  return `hsl(${Math.round(hue)} 45% 38%)`;
}
export function dataUri(mime: "image/svg+xml" | "image/png", bytes: Buffer | string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Deterministic monogram logo; safe for any id/name because every dynamic part is escaped or derived. */
export function monogramLogo(id: string, name: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="14" fill="${colorFor(id)}"/><text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="26" font-weight="600" fill="#fff">${escapeXml(initials(name))}</text></svg>`;
  return dataUri("image/svg+xml", svg);
}

/** Returns a data URI for a small valid PNG or a strictly sanitised SVG; otherwise null. */
export function sanitizeIcon(bytes: Buffer): string | null {
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) return null;
    return dataUri("image/png", bytes);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  text = text.replace(/^﻿/, "").trim().replace(/^<\?xml[^>]*\?>\s*/i, "").replace(/<!--[\s\S]*?-->/g, "");
  if (!/^<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) return null;
  if (/<!|<\?|&#|&[a-z]+;|javascript:|data:|@import|expression\(|\son[a-z]+\s*=|\sstyle\s*=|href\s*=|xlink|url\(\s*(?!["']?#)/i.test(text)) return null;
  for (const match of text.matchAll(/<\/?\s*([A-Za-z][\w:-]*)/g)) if (!SVG_TAGS.has(match[1]!.toLowerCase())) return null;
  return dataUri("image/svg+xml", text);
}

type Lookup = (host: string) => Promise<string[]>;
async function publicAddresses(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true });
  return rows.map(row => row.address);
}
export interface IconFetchOptions { fetchImpl?: typeof fetch; resolve?: Lookup }

/** Marketplace icon fetch: https, public hosts only, no redirects, hard size and time caps. */
export async function fetchMarketplaceIcon(rawUrl: string, options: IconFetchOptions = {}): Promise<string | null> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host)) return null;
  try {
    const addresses = await (options.resolve ?? publicAddresses)(host);
    if (!addresses.length || addresses.some(address => isPrivateAddress(address))) return null;
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { Accept: "image/png,image/svg+xml" } });
    if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_ICON_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    return sanitizeIcon(Buffer.concat(chunks));
  } catch { return null; }
}

/** Server-side icon cache: validated data URIs only, persisted privately, fetched lazily in the background. */
export class IconCache {
  readonly #entries = new Map<string, string>();
  readonly #pending = new Set<string>();
  readonly #failed = new Set<string>();
  readonly #path: string;
  readonly #options: IconFetchOptions;
  constructor(options: IconFetchOptions & { homeDir?: string } = {}) {
    this.#options = options;
    this.#path = join(homeStateDir(options.homeDir), "icon-cache.json");
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [key, value] of Object.entries(raw)) {
        // Re-validate on load: the cache file is never trusted.
        const match = typeof value === "string" ? /^data:(image\/png|image\/svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
        if (match && sanitizeIcon(Buffer.from(match[2]!, "base64"))) this.#entries.set(key, value as string);
      }
    } catch { /* empty cache */ }
  }
  #key(url: string): string { return createHash("sha256").update(url).digest("hex"); }
  /** Cached icon for this URL, or a monogram while a background fetch fills the cache. */
  logoFor(id: string, name: string, iconUrl?: unknown): string {
    if (typeof iconUrl === "string" && iconUrl) {
      const key = this.#key(iconUrl);
      const hit = this.#entries.get(key);
      if (hit) return hit;
      if (!this.#pending.has(key) && !this.#failed.has(key)) {
        this.#pending.add(key);
        void fetchMarketplaceIcon(iconUrl, this.#options).then(icon => {
          if (icon) { this.#entries.set(key, icon); this.#persist(); } else this.#failed.add(key);
        }).finally(() => this.#pending.delete(key));
      }
    }
    return monogramLogo(id, name);
  }
  /** Test hook: wait for outstanding fetches. */
  async idle(): Promise<void> { while (this.#pending.size) await new Promise(resolve => setTimeout(resolve, 5)); }
  #persist(): void {
    try {
      const entries = Object.fromEntries([...this.#entries].slice(-200));
      const dir = join(this.#path, "..");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" }); chmodSync(temporary, 0o600); renameSync(temporary, this.#path); }
      finally { rmSync(temporary, { force: true }); }
    } catch { /* cache is best effort */ }
  }
}
