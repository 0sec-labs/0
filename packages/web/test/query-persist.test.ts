import { expect, test } from "vitest";
import { QueryClient, dehydrate, type DehydratedState } from "@tanstack/react-query";
import { MAX_PERSISTED_SNAPSHOTS, isPersistableKey, limitSnapshots, parseCache, persistBuster, serializeCache, shouldDehydrateQuery } from "../src/lib/query-persist.js";

const buster = persistBuster("1.0.0");
const query = (queryKey: unknown[], data: unknown, dataUpdatedAt = 1000, status: "success" | "error" = "success") => ({ queryKey, queryHash: JSON.stringify(queryKey), state: { data, dataUpdatedAt, status, error: null, dataUpdateCount: 1, errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false, fetchStatus: "idle" } }) as unknown as DehydratedState["queries"][number];
const snapshot = (id: string, bytes = 10, transcript = 0) => ({ session: { id }, messages: ["x".repeat(bytes)], workers: [{ id: "w", transcript: Array.from({ length: transcript }, (_, turn) => ({ turn, text: "t".repeat(1000) })), operatorMessages: [] }] });

test("persists only allow-listed successful queries and never auth, errors or settings", () => {
  const client = new QueryClient();
  client.setQueryData(["console-sessions"], [{ id: "a" }]);
  client.setQueryData(["team-session"], { enabled: true });
  client.setQueryData(["console-settings", "local"], { secret: 1 });
  client.setQueryData(["console-snapshot", "scope", "a"], snapshot("a"));
  const state = dehydrate(client, { shouldDehydrateQuery });
  expect(state.queries.map(item => item.queryKey[0]).sort()).toEqual(["console-sessions", "console-snapshot"]);
  expect(isPersistableKey(["team-session"])).toBe(false);
  expect(shouldDehydrateQuery({ queryKey: ["console-sessions"], state: { status: "error", data: undefined } as never })).toBe(false);
});

test("keeps only the five most recent snapshots and every list", () => {
  const queries = [query(["console-sessions"], []), ...Array.from({ length: 8 }, (_, index) => query(["console-snapshot", "s", `m${index}`], snapshot(`m${index}`), index))];
  const limited = limitSnapshots({ mutations: [], queries });
  const kept = limited.queries.filter(item => item.queryKey[0] === "console-snapshot").map(item => item.queryKey[2]);
  expect(kept).toHaveLength(MAX_PERSISTED_SNAPSHOTS);
  expect(kept).not.toContain("m0");
  expect(kept).toContain("m7");
  expect(limited.queries.some(item => item.queryKey[0] === "console-sessions")).toBe(true);
});

test("round-trips and rejects a different buster, schema or expired payload", () => {
  const text = serializeCache({ mutations: [], queries: [query(["console-saved"], [{ id: "s" }])] }, { buster, now: 5000 })!;
  expect(parseCache(text, { buster, now: 6000 })?.queries).toHaveLength(1);
  expect(parseCache(text, { buster: persistBuster("2.0.0"), now: 6000 })).toBeNull();
  expect(parseCache(text, { buster, now: 5000 + 25 * 3600_000 })).toBeNull();
  expect(parseCache(JSON.stringify({ ...JSON.parse(text), schema: 99 }), { buster, now: 6000 })).toBeNull();
  expect(parseCache("not json", { buster })).toBeNull();
  expect(parseCache(undefined, { buster })).toBeNull();
});

test("drops non-allow-listed or errored entries found in storage", () => {
  const raw = JSON.stringify({ schema: 1, buster, timestamp: 1, state: { mutations: [], queries: [query(["team-session"], { enabled: true }), query(["console-saved"], [], 1, "error"), query(["console-saved"], [])] } });
  expect(parseCache(raw, { buster, now: 2 })?.queries).toHaveLength(1);
});

test("over the byte cap it trims worker transcripts (marking the snapshot expired) before dropping snapshots", () => {
  const state: DehydratedState = { mutations: [], queries: [query(["console-snapshot", "s", "a"], snapshot("a", 10, 50), 9), query(["console-snapshot", "s", "b"], snapshot("b", 10, 50), 8)] };
  const trimmed = parseCache(serializeCache(state, { buster, maxBytes: 4000 }), { buster })!;
  expect(trimmed.queries).toHaveLength(2);
  expect((trimmed.queries[0]!.state.data as ReturnType<typeof snapshot>).workers[0]!.transcript).toEqual([]);
  expect(trimmed.queries[0]!.state.dataUpdatedAt).toBe(0);
  const fewer = parseCache(serializeCache({ mutations: [], queries: [query(["console-snapshot", "s", "a"], snapshot("a", 2500), 9), query(["console-snapshot", "s", "b"], snapshot("b", 2500), 8)] }, { buster, maxBytes: 3500 }), { buster })!;
  expect(fewer.queries.map(item => item.queryKey[2])).toEqual(["a"]);
  const none = parseCache(serializeCache({ mutations: [], queries: [query(["console-snapshot", "s", "a"], snapshot("a", 9000), 9)] }, { buster, maxBytes: 3000 }), { buster })!;
  expect(none.queries).toEqual([]);
  expect(serializeCache({ mutations: [], queries: [query(["console-sessions"], "x".repeat(5000))] }, { buster, maxBytes: 3000 })).toBeNull();
});
