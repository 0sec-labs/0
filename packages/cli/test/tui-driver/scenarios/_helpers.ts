/**
 * Shared helpers for TUI scenarios. Not a `*.tui.test.ts`, so it is not
 * collected as a test file — only imported.
 */

import type { LaunchOptions, TuiHandle } from "../index.js";
import { degradePalette, detectColorDepth, getTheme, parseHex } from "../../../src/tui/themes.js";
import type { CapturedFrame } from "@opentui/core";

/** Model discovery for exactly the synthetic fixture credentials; all other HTTP fails offline. */
export const fixtureModelFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const authorization = headers.get("Authorization");
  if (url === "https://api.deepseek.com/models" &&
    ["Bearer test-key", "Bearer synthetic-existing-key"].includes(authorization ?? "")) {
    return Response.json({ data: ["deepseek-chat", "deepseek-flash", "deepseek-reasoner", "deepseek-v4-flash"].map(id => ({ id, context_length: 128_000 })) });
  }
  if (url === "https://api.anthropic.com/v1/models" && headers.get("x-api-key") === "synthetic-embedded-anthropic-key") {
    return Response.json({ data: [{ id: "claude-fable-5-1", max_input_tokens: 200_000 }, { id: "claude-sonnet-4-6", max_input_tokens: 200_000 }] });
  }
  return new Response(null, { status: 503 });
};

/**
 * Pin a direct provider and model for deterministic picker navigation. The
 * fixture supplies a credential and an active model from the first paint;
 * `mouseSupport` is opt-in for scenarios that need hover hit testing.
 */
export function modelsByokLaunch(opts: { mouse?: boolean } = {}): LaunchOptions {
  return {
    route: { type: "models" },
    fetchImpl: fixtureModelFetch,
    settings: opts.mouse ? { mouseSupport: true } : {},
    env: {
      DEEPSEEK_API_KEY: "test-key",
      "ZERO_PROVIDER": "deepseek",
      "ZERO_MODEL": "deepseek-chat",
    },
  };
}

/** Route one OpenAI id through both OpenAI and Azure to exercise provider-qualified rows. */
export function duplicateProviderModelsLaunch(opts: { mouse?: boolean } = {}): LaunchOptions {
  return {
    route: { type: "models" },
    settings: opts.mouse ? { mouseSupport: true } : {},
    env: {
      OPENAI_API_KEY: "test-openai-key",
      AZURE_OPENAI_API_KEY: "test-azure-key",
      AZURE_OPENAI_BASE_URL: "https://azure.invalid",
      ZERO_PROVIDER: "openai",
      ZERO_MODEL: "gpt-6-luna",
    },
  };
}

/** Locate the selected list row, not the popup background or sidebar surface.
 * Scenarios use the deterministic fixture's blue-team theme unless overridden.
 */
export function highlightedRow(
  frame: CapturedFrame,
  themeName = "blue-team",
): { index: number; text: string } {
  const color = parseHex(degradePalette(getTheme(themeName), detectColorDepth(process.env)).PRIMARY)!;
  const highlight = `${color.r},${color.g},${color.b}`;
  let index = -1;
  let bestWidth = 0;
  let text = "";
  frame.lines.forEach((line, i) => {
    let width = 0;
    let lineText = "";
    for (const span of line.spans) {
      if (span.bg.toInts().slice(0, 3).join(",") === highlight) {
        width += span.width;
        lineText += span.text;
      }
    }
    const trimmed = lineText.trim();
    // A highlighted list row: a partial-width coloured run that carries text.
    // Exclude the full-width chrome bars (>= cols-5) and the blank gutter cells.
    if (trimmed.length > 0 && width > 10 && width < frame.cols - 5 && width > bestWidth) {
      bestWidth = width;
      index = i;
      text = trimmed;
    }
  });
  return { index, text };
}

/** The model id from a highlighted list row's text (drops the `●` current dot and price). */
export function modelLabel(rowText: string): string {
  return (rowText.replace(/^●\s*/, "").split(/\s{2,}|\$/)[0] ?? "").trim();
}

/** The empty-chat landing screen exposes its always-available Connect action. */
export const HOME_READY = /\[\/connect\]/;

/** Any box-drawing glyph: light/heavy/double borders, corners, tees and dividers. */
export const BORDER_GLYPHS =
  /[─-╿]/; // Unicode "Box Drawing" block (│ ─ ╭ ╮ ╰ ╯ ┌ ┐ … ═ ║).

/** The framebuffer's blank-cell fill glyph, replaced with a space for readable slices. */
const FILL = /਀/g;

/** Split a captured frame into lines with the fill glyph normalized to spaces. */
export function frameLines(frame: string): string[] {
  return frame.replace(FILL, " ").split("\n");
}

/**
 * The inclusive slice of lines between the first line matching `from` and the
 * first later line matching `to`. Throws a helpful error (with the frame) if
 * either marker is missing, so a scenario fails loudly rather than on an empty
 * slice.
 */
export function regionBetween(frame: string, from: RegExp, to: RegExp): string[] {
  const lines = frameLines(frame);
  const start = lines.findIndex((l) => from.test(l));
  if (start === -1) throw new Error(`region start ${from} not found in frame:\n${lines.join("\n")}`);
  const end = lines.findIndex((l, i) => i > start && to.test(l));
  if (end === -1) throw new Error(`region end ${to} not found in frame:\n${lines.join("\n")}`);
  return lines.slice(start, end + 1);
}
