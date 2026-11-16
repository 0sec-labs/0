/** Pure helpers for the Models page: logos, ordering and connection usage. No DOM, no network. */

/** Logos must be same-origin: a data: image or an absolute path on this origin. Anything remote is dropped so the CSP never blocks a request and nothing leaks. */
export function safeLogo(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const value = src.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif);base64,[A-Za-z0-9+/=]+$/i.test(value) && value.length <= 400_000) return value;
  if (/^\/(?![/\\])[A-Za-z0-9._~\-/%]+$/.test(value) && !value.includes("..")) return value;
  return undefined;
}

export const countLabel = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Moves one id up or down. Out-of-range moves and unknown ids return the same array. */
export function moveId(order: string[], id: string, delta: -1 | 1): string[] {
  const from = order.indexOf(id); const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = order.slice(); next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}
/** Drops `id` and reinserts it before/after `target`. */
export function moveBefore(order: string[], id: string, target: string): string[] {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const without = order.filter(item => item !== id);
  without.splice(without.indexOf(target), 0, id);
  return without;
}

export interface UsageBar { label: string; usedPercent: number; caption: string; breakdown: string[] }
const money = (value: number, currency: string) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); } catch { return `${value.toFixed(2)} ${currency}`; } };
/** Turns the backend's connection usage into one bar. Only a real credit limit produces a bar; "not exposed" or missing data returns null so the UI hides it rather than inventing numbers. */
export function usageBar(raw: unknown): UsageBar | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as { available?: unknown; window?: unknown };
  if (usage.available !== true || !usage.window || typeof usage.window !== "object") return null;
  const window = usage.window as Record<string, unknown>;
  const num = (key: string) => typeof window[key] === "number" && Number.isFinite(window[key]) ? window[key] as number : undefined;
  const limit = num("limit"); const remaining = num("remaining");
  if (limit === undefined || limit <= 0 || remaining === undefined) return null;
  const currency = typeof window.currency === "string" && /^[A-Z]{3}$/.test(window.currency) ? window.currency : "USD";
  const used = Math.max(0, limit - remaining);
  const breakdown = ([["today", "usedDaily"], ["this week", "usedWeekly"], ["this month", "usedMonthly"]] as const).flatMap(([label, key]) => { const value = num(key); return value === undefined ? [] : [`${money(value, currency)} ${label}`]; });
  return { label: "Credit limit", usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)), caption: `${money(used, currency)} of ${money(limit, currency)} used`, breakdown };
}
