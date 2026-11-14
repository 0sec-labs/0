const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
const spinnerGlyph = (frame: number): string => SPINNER_FRAMES[Math.max(0, Math.floor(frame)) % SPINNER_FRAMES.length]!;

/** One terminal line; never writes animation or control codes to redirected logs. */
export function terminalProgress(label: string, output: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> = process.stderr) {
  const animated = Boolean(output.isTTY && process.env["TERM"] !== "dumb");
  const started = Date.now();
  let frame = 0;
  let stage = label;
  let finished = false;
  const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
  const paint = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const line = `${spinnerGlyph(frame++)} ${stage} · ${elapsed}s`;
    output.write(`\r\x1b[2K${Array.from(line).slice(0, Math.max(12, (output.columns ?? 80) - 1)).join("")}`);
  };
  if (animated) paint();
  else output.write(`${clean(label)}…\n`);
  const timer = animated ? setInterval(paint, 120) : undefined;
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
