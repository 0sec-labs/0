/** Pure: text from a third-party MCP server, made safe to show an operator or a model as plain text. */

/** C0/C1 controls, bidi overrides and isolates, zero-width and other invisible format characters, line/paragraph separators. */
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/g;

export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const isToolName = (name: unknown): name is string => typeof name === "string" && TOOL_NAME.test(name);

/** One line of plain text: invisible and control characters removed, whitespace collapsed, clamped with an ellipsis. */
export function safeText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  const clean = text.slice(0, max * 4).replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

/** A tool name that is safe to print: validated against the tool-name pattern, else replaced by a marker (never echoed). */
export const displayName = (name: unknown): string => (isToolName(name) ? name : "[invalid tool name]");

/** Text with invisible characters removed and compatibility forms (full-width, ligatures) folded, newlines kept. */
export function foldText(value: string): string { return value.replace(INVISIBLE, m => (m === "\n" || m === "\t" ? m : "")).normalize("NFKC"); }

const LOOKALIKE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ѕ": "s", "ј": "j", "һ": "h", "ԁ": "d", "ɡ": "g", "ո": "n", "ս": "u",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ѕ": "S", "Ј": "J",
  "Α": "A", "Β": "B", "Ε": "E", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "ο": "o", "ν": "v", "ι": "i",
  "‹": "<", "›": ">", "«": "<", "»": ">", "〈": "<", "〉": ">", "＜": "<", "＞": ">", "_": "_", "‗": "_", "＿": "_", "﹍": "_", "﹎": "_", "﹏": "_",
};
/** One UTF-16 unit in, one out, so an index in the folded text is the same index in the original. Only for matching, never for output. */
export const confusableFold = (value: string): string => value.replace(/[^\u0000-\u007f]/gu, ch => (ch.length === 1 ? LOOKALIKE[ch] ?? ch : ch));
