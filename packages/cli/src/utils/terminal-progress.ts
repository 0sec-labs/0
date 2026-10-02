import { spinnerGlyph } from "../tui/animations.js";

/** One terminal line; never writes animation or control codes to redirected logs. */
export function terminalProgress(label: string, output: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> = process.stderr, reduceMotion = false) {
  const animated = Boolean(output.isTTY && process.env["TERM"] !== "dumb");
  const started = Date.now();
  let frame = 0;
  let stage = label;
  let finished = false;
  const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
  const paint = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const line = `${spinnerGlyph(frame++, { reduceMotion })} ${stage} · ${elapsed}s`;
    output.write(`\r\x1b[2K${Array.from(line).slice(0, Math.max(12, (output.columns ?? 80) - 1)).join("")}`);
  };
  if (animated) paint();
  else output.write(`${clean(label)}…\n`);
  const timer = animated && !reduceMotion ? setInterval(paint, 120) : undefined;
  timer?.unref();
  return {
    update(text: string) { if (finished) return; stage = clean(text) || label; if (animated) paint(); },
    finish(text?: string) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (animated) output.write("\r\x1b[2K");
      if (text) output.write(`${clean(text)}\n`);
    },
  };
}
