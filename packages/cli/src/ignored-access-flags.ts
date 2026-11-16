/**
 * There is one mode. The old access flags (--access, --mode, --yolo, --autonomy, --tool-access) are still accepted
 * for one release so scripts do not break, but they do nothing and are not in the help.
 */
export const IGNORED_ACCESS_FLAGS = ["--access", "--mode", "--yolo", "--autonomy", "--tool-access"] as const;

let noted = false;
/** One dim stderr line, only on a TTY and never with --json; at most once per process. Returns whether it printed. */
export function noteIgnoredAccessFlags(given: boolean, opts: { json?: boolean } = {}): boolean {
  if (!given || noted || opts.json || !process.stderr.isTTY) return false;
  noted = true;
  process.stderr.write("\x1b[2mignored: there is only one mode\x1b[22m\n");
  return true;
}
/** Test hook. */
export function resetIgnoredAccessNote(): void { noted = false; }
/** True when any retired access option appears on a parsed options object. */
export function givenAccessOption(opts: Record<string, unknown>): boolean {
  return ["access", "mode", "yolo", "autonomy", "toolAccess", "accessLevel"].some(key => opts[key] !== undefined);
}
