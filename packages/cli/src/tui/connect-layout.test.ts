import { describe, expect, it } from "vitest";

import {
  RECOMMENDED_IDS,
  authHintLabel,
  authKindFor,
  buildConnectRows,
  clipConnectDetailLines,
  computeConnectLayout,
  computeConnectTitleLayout,
  connectConnectedCounts,
  connectDetailLines,
  connectDetailTitleLabel,
  connectDetailTitleMeta,
  connectDialogItems,
  connectDisplayRowCount,
  connectFooterHint,
  connectInputMask,
  connectRowForId,
  connectStatusLine,
  hasAnyConnection,
  isFilterKey,
  isInputKey,
  pastableChars,
  shellChromeRows,
  type ConnectRow,
} from "./connect-layout.js";
import { PROVIDERS, providerStates } from "./provider-status.js";

const isInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * A swept axis: every `step`th value in `[min, max]`, plus the boundary sizes
 * (`min`, `min+1`, `min+2`, `max`) always tested explicitly. This keeps the
 * small/edge and large-end coverage of a dense 0..max loop while running a
 * fraction of the iterations.
 */
const sweepAxis = (min: number, max: number, step: number): number[] => {
  const seen = new Set<number>([min, min + 1, min + 2, max]);
  for (let v = min; v <= max; v += step) seen.add(v);
  return [...seen].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
};

const EMPTY = providerStates({});
const LIT_PROVIDER = PROVIDERS.find((info) => info.id === "anthropic") ?? PROVIDERS[0];
const LIT = providerStates({ [LIT_PROVIDER?.envVars[0] ?? "ANTHROPIC_API_KEY"]: "sk-test" });

describe("computeConnectLayout — the dialog sweep", () => {
  it("partitions exactly the rows and cells the host left it", () => {
    for (const width of sweepAxis(0, 200, 3)) {
      for (const height of sweepAxis(0, 80, 2)) {
        // In a dialog the host spends one row on its footer and nothing else.
        for (const options of [undefined, { chromeRows: 1, chromeColumns: 0 }]) {
          const layout = computeConnectLayout(width, height, 40, options);
          const at = `${width}x${height} ${options ? "in a dialog" : "on a terminal"}`;
          for (const [name, value] of Object.entries(layout)) {
            if (typeof value !== "number") continue;
            expect(isInteger(value), `${name} was ${value} at ${at}`).toBe(true);
          }
          expect(layout.contentWidth, `content wider than the surface at ${at}`)
            .toBeLessThanOrEqual(Math.max(0, width));
          expect(
            layout.titleRows + layout.bodyRows + layout.statusRows,
            `rows did not sum to the budget at ${at}`,
          ).toBe(layout.availableRows);
          expect(layout.availableRows, `body taller than the surface at ${at}`)
            .toBeLessThanOrEqual(Math.max(0, height));
          if (!options) {
            // On a bare terminal the console shell still takes its chrome.
            expect(layout.availableRows, `shell chrome not paid for at ${at}`)
              .toBe(Math.max(0, Math.trunc(height) - shellChromeRows(width)));
          }
          expect(layout.listRows + layout.stackedRows).toBe(layout.bodyRows);
          expect(
            layout.panel.listWidth + layout.panel.detailGap + layout.panel.detailWidth,
            `picker columns overflowed the content width at ${at}`,
          ).toBeLessThanOrEqual(Math.max(1, layout.contentWidth));
          expect(layout.panel.rowWidth).toBeLessThanOrEqual(layout.panel.listWidth);
        }
      }
    }
  });

  it("keeps the whole surface when the host is a dialog panel", () => {
    // Inside a dialog the surface already IS the panel's inner box.
    const dialog = computeConnectLayout(92, 40, 40, { chromeRows: 1, chromeColumns: 0 });
    expect(dialog.contentWidth).toBe(92);
    expect(dialog.availableRows).toBe(39);
    expect(dialog.panel.showDetail).toBe(true);
    expect(computeConnectLayout(92, 40, 40).bodyRows).toBeLessThan(dialog.bodyRows);
  });

  it("drops the detail column rather than shrinking it below its floor", () => {
    const narrow = computeConnectLayout(48, 36, 40, { chromeRows: 0, chromeColumns: 0 });
    expect(narrow.panel.showDetail).toBe(false);
    expect(narrow.panel.detailWidth).toBe(0);
    expect(narrow.stackedRows).toBeGreaterThan(0);
    const wide = computeConnectLayout(120, 36, 40, { chromeRows: 0, chromeColumns: 0 });
    expect(wide.panel.showDetail).toBe(true);
    expect(wide.stackedRows).toBe(0);
  });

  it("survives garbage geometry without throwing or producing garbage", () => {
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, -10, 1.5]) {
      for (const height of [Number.NaN, Number.NEGATIVE_INFINITY, -4, 2.7]) {
        const layout = computeConnectLayout(width as number, height as number, 40);
        for (const [name, value] of Object.entries(layout)) {
          if (typeof value !== "number") continue;
          expect(isInteger(value), `${name} was ${value} at ${width}x${height}`).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("computeConnectTitleLayout — the header sweep", () => {
  it("splits a header into a title and meta that sum to the width", () => {
    for (let inner = 0; inner <= 120; inner++) {
      for (const metaLength of [0, 1, 3, 12, 30, 200]) {
        const title = computeConnectTitleLayout(inner, metaLength);
        const at = `inner ${inner}, meta ${metaLength}`;
        expect(title.width, `header wider than the pane at ${at}`).toBe(Math.max(0, inner));
        expect(
          title.titleWidth + title.gap + title.metaWidth,
          `header claimed ${title.titleWidth + title.gap + title.metaWidth} of ${title.width} at ${at}`,
        ).toBe(title.width);
        expect(title.metaWidth).toBeLessThanOrEqual(Math.max(0, metaLength));
        if (title.metaWidth > 0) {
          expect(title.gap, `meta had no gap at ${at}`).toBe(1);
          expect(title.titleWidth, `title squeezed out at ${at}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("gives the meta its own cells on a wide header and drops it on a narrow one", () => {
    const wide = computeConnectTitleLayout(60, 12);
    expect(wide.metaWidth).toBe(12);
    expect(wide.titleWidth).toBeGreaterThan(0);
    expect(wide.gap).toBe(1);
    const narrow = computeConnectTitleLayout(6, 12);
    expect(narrow.metaWidth).toBe(0);
    expect(narrow.gap).toBe(0);
    expect(narrow.titleWidth).toBe(6);
  });
});

describe("pane header labels and meta", () => {
  const rows = buildConnectRows({ states: LIT });


  it("summarises the highlighted provider's connection state for the detail header", () => {
    expect(connectDetailTitleLabel()).toBe("PROVIDER");
    const connected = rows.find(
      (r) => r.kind === "provider" && r.provider.id === LIT_PROVIDER?.id,
    );
    expect(connectDetailTitleMeta(connected)).toBe("connected");
    const dark = rows.find((r) => r.kind === "provider" && !r.provider.connected);
    expect(connectDetailTitleMeta(dark)).toBe("not connected");
    // No provider highlighted -> no meta.
    expect(connectDetailTitleMeta(rows.find((r) => r.kind === "heading"))).toBe("");
    expect(connectDetailTitleMeta(undefined)).toBe("");
  });
});

describe("buildConnectRows", () => {
  it("keeps Cloud first, BYOK second and subscription sign-in independent", () => {
    const rows = buildConnectRows({ states: EMPTY });
    expect(rows[0]?.kind).toBe("cloud");
    const providers = rows.filter((row) => row.kind === "provider");
    expect(providers[0]?.provider.auth).toBe("api-key");
    expect(new Set(providers.map((row) => row.provider.id))).toEqual(new Set(PROVIDERS.map((provider) => provider.id)));
    expect(providers.length).toBe(PROVIDERS.length);
    const subscription = providers.filter((row) => row.group.id === "subscription");
    // Every OAuth-preferred provider lands in the subscription group, in the
    // PROVIDERS table order: chatgpt-codex, openrouter, kimi, xai.
    expect(subscription.map((row) => row.provider.id)).toEqual(["chatgpt-codex", "openrouter", "kimi", "xai"]);
    expect(providers.filter((row) => row.group.id !== "subscription").every((row) => row.provider.auth === "api-key")).toBe(true);
    expect(providers.every((row) => !row.provider.connected)).toBe(true);

    // The headings still arrive in a fixed order, and the groups stay disjoint.
    const headings = rows.filter(
      (row): row is Extract<ConnectRow, { kind: "heading" }> => row.kind === "heading",
    );
    expect(headings.map((row) => row.group.id)).toEqual(["popular", "all", "subscription"]);
    const idsIn = (group: string) =>
      providers.filter((row) => row.group.id === group).map((row) => row.provider.id);
    const popular = idsIn("popular");
    const all = idsIn("all");
    expect(popular).toEqual(RECOMMENDED_IDS.filter((id) => PROVIDERS.some((p) => p.id === id)));
    expect(popular.filter((id) => all.includes(id))).toEqual([]);
    expect([...popular, ...all].filter((id) => subscription.some((row) => row.provider.id === id))).toEqual([]);
  });

  it("emits a subtitle row under recommended providers that have one", () => {
    const rows = buildConnectRows({ states: EMPTY });
    const at = rows.findIndex(
      (row) => row.kind === "provider" && row.provider.id === RECOMMENDED_IDS[0],
    );
    expect(rows[at + 1]?.kind).toBe("subtitle");
    // Subtitles never appear in the All group.
    for (const row of rows) {
      if (row.kind === "subtitle") expect(row.group.id).toBe("popular");
    }
  });

  it("marks a provider connected when the environment holds a credential", () => {
    const rows = buildConnectRows({ states: LIT });
    const anthropic = rows.find(
      (row) => row.kind === "provider" && row.provider.id === LIT_PROVIDER?.id,
    );
    expect(anthropic?.kind).toBe("provider");
    if (anthropic?.kind === "provider") {
      expect(anthropic.provider.connected).toBe(true);
      expect(anthropic.provider.source).toBe("env");
      expect(anthropic.provider.via).toBe(LIT_PROVIDER?.envVars[0]);
    }
  });

  it("marks a provider connected when only the credential store holds it", () => {
    const rows = buildConnectRows({ states: EMPTY, stored: ["openai"] });
    const openai = rows.find((row) => row.kind === "provider" && row.provider.id === "openai");
    if (openai?.kind === "provider") {
      expect(openai.provider.connected).toBe(true);
      expect(openai.provider.source).toBe("stored");
    } else {
      throw new Error("openai row missing");
    }
  });

  it("prefers the environment source over the store when both hold a credential", () => {
    const rows = buildConnectRows({ states: LIT, stored: [LIT_PROVIDER?.id ?? ""] });
    const row = rows.find((r) => r.kind === "provider" && r.provider.id === LIT_PROVIDER?.id);
    if (row?.kind === "provider") expect(row.provider.source).toBe("env");
  });

  it("filters on id, label and auth hint, dropping empty headings", () => {
    const byLabel = buildConnectRows({ states: EMPTY, filter: "anthropic" });
    expect(byLabel.filter((row) => row.kind === "provider")).toHaveLength(1);
    // Every heading kept must have a provider under it.
    byLabel.forEach((row, index) => {
      if (row.kind === "heading") expect(byLabel[index + 1]?.kind).toBe("provider");
    });
    const byOauth = buildConnectRows({ states: EMPTY, filter: "oauth" });
    expect(byOauth.filter((row) => row.kind === "provider").length).toBeGreaterThan(0);
    for (const row of byOauth) {
      if (row.kind === "provider") expect(row.provider.auth).toBe("oauth");
    }
    expect(buildConnectRows({ states: EMPTY, filter: "zzzznope" })).toEqual([]);
  });

  it("is stable for the same inputs", () => {
    expect(buildConnectRows({ states: LIT })).toEqual(buildConnectRows({ states: LIT }));
  });
});

// ---------------------------------------------------------------------------

describe("connectDialogItems — the projection onto the shared picker", () => {
  it("keeps Cloud first and groups every provider under its own category", () => {
    const rows = buildConnectRows({ states: EMPTY });
    const items = connectDialogItems({ rows });
    expect(items[0]?.id).toBe("hosted");
    expect(items[0]?.category).toBe("0sec Cloud");
    // Every provider row reaches the picker exactly once, under its group.
    const providers = rows.filter((row) => row.kind === "provider");
    expect(items).toHaveLength(providers.length + 1);
    for (const row of providers) {
      const item = items.find((candidate) => candidate.id === row.provider.id);
      expect(item, `${row.provider.id} never reached the picker`).toBeDefined();
      expect(item?.category).toBe(row.group.label);
      expect(item?.label).toBe(row.provider.label);
    }
    // A subtitle row becomes the item's description, not a row of its own.
    const recommended = items.find((item) => item.id === RECOMMENDED_IDS[0]);
    expect(recommended?.description).toBeTruthy();
  });

  it("marks an item connected only when a credential was actually found", () => {
    const items = connectDialogItems({ rows: buildConnectRows({ states: LIT }) });
    const lit = items.find((item) => item.id === LIT_PROVIDER?.id);
    expect(lit?.current).toBe(true);
    expect(lit?.meta).toBe("connected");
    for (const item of items) {
      if (item.id === LIT_PROVIDER?.id || item.id === "hosted") continue;
      expect(item.current, `${item.id} claimed a connection it does not have`).toBe(false);
      expect(item.meta).not.toBe("connected");
    }
  });

  it("never marks the provider being repaired as connected", () => {
    const rows = buildConnectRows({ states: LIT });
    const items = connectDialogItems({ rows, recoveryProviderId: LIT_PROVIDER?.id });
    const lit = items.find((item) => item.id === LIT_PROVIDER?.id);
    expect(lit?.current).toBe(false);
    expect(lit?.meta).toBe("reconnect");
  });

  it("reports the cloud row's own state and never assumes it", () => {
    const rows = buildConnectRows({ states: EMPTY });
    expect(connectDialogItems({ rows })[0]?.current).toBe(false);
    expect(connectDialogItems({ rows })[0]?.meta).toBe("sign in");
    const signedIn = connectDialogItems({ rows, cloudConnected: true })[0];
    expect(signedIn?.current).toBe(true);
    expect(signedIn?.meta).toBe("login saved");
    const repairing = connectDialogItems({ rows, cloudConnected: true, recoveryProviderId: "hosted" })[0];
    expect(repairing?.current).toBe(false);
    expect(repairing?.meta).toBe("reconnect");
  });

  it("carries the two lifecycle colours the list used to draw, and only those", () => {
    const rows = buildConnectRows({ states: LIT });
    const items = connectDialogItems({
      rows,
      tones: { connected: "#green", recovering: "#red" },
    });
    expect(items.find((item) => item.id === LIT_PROVIDER?.id)?.tone).toBe("#green");
    for (const item of items) {
      if (item.current) continue;
      expect(item.tone, `${item.id} was coloured without a state to justify it`).toBeUndefined();
    }
    const repairing = connectDialogItems({
      rows,
      tones: { connected: "#green", recovering: "#red" },
      recoveryProviderId: LIT_PROVIDER?.id,
    });
    expect(repairing.find((item) => item.id === LIT_PROVIDER?.id)?.tone).toBe("#red");
    // No palette supplied -> no colour invented.
    expect(connectDialogItems({ rows }).every((item) => item.tone === undefined)).toBe(true);
  });

  it("carries no secret onto an item", () => {
    const items = connectDialogItems({ rows: buildConnectRows({ states: LIT }) });
    const serialised = JSON.stringify(items);
    expect(serialised).not.toContain("sk-test");
  });

  it("counts the display rows the picker will render", () => {
    const items = connectDialogItems({ rows: buildConnectRows({ states: EMPTY }) });
    const categories = new Set(items.map((item) => item.category));
    expect(connectDisplayRowCount(items)).toBe(items.length + categories.size);
    expect(connectDisplayRowCount([])).toBe(0);
  });

  it("finds the row behind an item id, cloud included", () => {
    const rows = buildConnectRows({ states: LIT });
    expect(connectRowForId(rows, "hosted")?.kind).toBe("cloud");
    const row = connectRowForId(rows, LIT_PROVIDER?.id);
    expect(row?.kind === "provider" && row.provider.id).toBe(LIT_PROVIDER?.id);
    expect(connectRowForId(rows, undefined)).toBeUndefined();
    expect(connectRowForId(rows, "no-such-provider")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("the detail pane", () => {
  const rows = buildConnectRows({ states: LIT });
  const textOf = (lines: { text: string }[]): string => lines.map((line) => line.text).join("\n");

  it("describes a connected provider with its live source", () => {
    const row = rows.find((r) => r.kind === "provider" && r.provider.id === LIT_PROVIDER?.id);
    const text = textOf(connectDetailLines({ row }, 60));
    expect(text).toContain(LIT_PROVIDER?.label ?? "");
    expect(text).toContain("Connected:");
    expect(text).toContain(LIT_PROVIDER?.envVars[0] ?? "");
  });

  it("gives the exact setup hint for a provider with no credentials", () => {
    const dark = PROVIDERS.find((info) => info.id !== LIT_PROVIDER?.id);
    const row = rows.find((r) => r.kind === "provider" && r.provider.id === dark?.id);
    const text = textOf(connectDetailLines({ row }, 80));
    expect(text).toContain("Not connected");
    for (const word of (dark?.hint ?? "").split(" ").slice(0, 3)) expect(text).toContain(word);
    expect(text).toContain(dark?.envVars[0] ?? "");
  });

  it("names the device OAuth path for ChatGPT Codex", () => {
    const row = rows.find((r) => r.kind === "provider" && r.provider.auth === "oauth");
    const text = textOf(connectDetailLines({ row }, 80));
    expect(text.toLowerCase()).toContain("oauth");
  });

  it("keeps every detail line inside the pane it was measured for", () => {
    for (const row of rows) {
      for (const width of [0, 1, 8, 20, 30, 44, 56]) {
        for (const line of connectDetailLines({ row }, width)) {
          expect(line.text.length, `overflowed a ${width}-cell pane`).toBeLessThanOrEqual(width);
        }
      }
    }
    // Non-provider rows and empty input produce nothing.
    const heading = rows.find((row) => row.kind === "heading");
    expect(connectDetailLines({ row: heading }, 48)).toEqual([]);
    expect(connectDetailLines({}, 48)).toEqual([]);
  });

  it("spends no rows on blanks in compact mode", () => {
    const row = rows.find((r) => r.kind === "provider");
    const full = connectDetailLines({ row }, 40);
    const compact = connectDetailLines({ row, compact: true }, 40);
    expect(compact.some((line) => line.tone === "blank")).toBe(false);
    expect(compact.map((line) => line.text)).toEqual(
      full.filter((line) => line.tone !== "blank").map((line) => line.text),
    );
  });

  it("clips overflow and marks the cut", () => {
    const row = rows.find((r) => r.kind === "provider" && !r.provider.connected);
    const lines = connectDetailLines({ row }, 24);
    expect(lines.length).toBeGreaterThan(3);
    expect(clipConnectDetailLines(lines, 3)).toHaveLength(3);
    expect(clipConnectDetailLines(lines, 3).at(-1)?.text).toBe("...");
    expect(clipConnectDetailLines(lines, 0)).toEqual([]);
    expect(clipConnectDetailLines(lines, lines.length + 5)).toHaveLength(lines.length);
    const inline = clipConnectDetailLines(lines, 3, 24);
    expect(inline.at(-1)?.text.endsWith(" ...")).toBe(true);
    for (const line of inline) expect(line.text.length).toBeLessThanOrEqual(24);
  });
});

// ---------------------------------------------------------------------------

describe("connected reporting, masks and hints", () => {
  it("reports any connection across env and store", () => {
    expect(hasAnyConnection({ states: EMPTY })).toBe(false);
    expect(hasAnyConnection({ states: EMPTY, stored: [] })).toBe(false);
    expect(hasAnyConnection({ states: LIT })).toBe(true);
    expect(hasAnyConnection({ states: EMPTY, stored: ["openai"] })).toBe(true);
    expect(hasAnyConnection({ states: EMPTY, stored: new Set(["kimi"]) })).toBe(true);
  });

  it("summarises how many providers are connected", () => {
    expect(connectStatusLine(buildConnectRows({ states: EMPTY }))).toContain("no providers connected");
    const rows = buildConnectRows({ states: LIT });
    const line = connectStatusLine(rows);
    expect(line).toMatch(/connected: 1 of \d+ providers/);
    expect(connectStatusLine([])).toBe("no providers to connect");
    // The title meta counts the same rows, and never counts the cloud row.
    const counts = connectConnectedCounts(rows);
    expect(counts.connected).toBe(1);
    expect(counts.total).toBe(PROVIDERS.length);
    expect(connectConnectedCounts([])).toEqual({ connected: 0, total: 0 });
  });

  it("never echoes the credential and caps the mask length it leaks", () => {
    expect(connectInputMask(0)).toBe("");
    expect(connectInputMask(3)).toBe("•••");
    expect(connectInputMask(8)).toBe("••••••••");
    // Past the cap the exact length is hidden behind an ellipsis.
    expect(connectInputMask(9)).toBe("••••••••…");
    expect(connectInputMask(500)).toBe("••••••••…");
    for (const length of [1, 5, 50, 500]) {
      expect(connectInputMask(length).replace(/[•…]/g, "")).toBe("");
    }
  });

  it("labels auth kinds in words", () => {
    expect(authKindFor("chatgpt-codex")).toBe("oauth");
    expect(authKindFor("openai")).toBe("api-key");
    expect(authHintLabel("oauth")).toBe("OAuth");
    expect(authHintLabel("api-key")).toBe("API key");
    // The auth hint fits the 12-cell column it is budgeted for.
    for (const kind of ["oauth", "api-key"] as const) {
      expect(authHintLabel(kind).length).toBeLessThanOrEqual(12);
    }
  });

  it("names the real keys in the footer hints", () => {
    expect(connectFooterHint("browse")).toContain("enter connect");
    expect(connectFooterHint("browse")).toContain("↑↓ select");
    expect(connectFooterHint("browse", false)).toContain("esc back");
    expect(connectFooterHint("browse", true)).toContain("esc clear filter");
    expect(connectFooterHint("filter")).toContain("backspace");
    expect(connectFooterHint("input")).toContain("save");
    expect(connectFooterHint("input")).toContain("cancel");
  });

  it("routes printable characters to filter and input, control keys to neither", () => {
    for (const key of ["a", "Z", "5", "-", ".", " ", "s"]) {
      expect(isFilterKey(key)).toBe(true);
      expect(isInputKey(key)).toBe(true);
    }
    for (const key of ["\x1b", "\x7f", "\r", "ab", undefined]) {
      expect(isFilterKey(key)).toBe(false);
      expect(isInputKey(key)).toBe(false);
    }
  });

  it("keeps the printable characters of a pasted sequence and drops control bytes", () => {
    expect(pastableChars("sk-ant-abc123")).toBe("sk-ant-abc123");
    expect(pastableChars("sk-key\n")).toBe("sk-key");
    expect(pastableChars("a\x1bb\x7fc\r")).toBe("abc");
    expect(pastableChars("")).toBe("");
    expect(pastableChars(undefined)).toBe("");
    expect(pastableChars(123)).toBe("");
  });

  it("keeps every recommended id a real provider", () => {
    for (const id of RECOMMENDED_IDS) {
      expect(PROVIDERS.some((info) => info.id === id), `${id} is not a real provider`).toBe(true);
    }
  });
});
