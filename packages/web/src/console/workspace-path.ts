/** Folder display name: the folder name, with its parent when the name is too short to mean anything (e.g. `0sec-labs/0security`). */
export function folderLabel(path: string) {
  const parts = path.normalize("NFC").split(/[\\/]+/).filter(Boolean);
  // iCloud Drive keeps Desktop, Documents and app folders under a long Library path; show what the operator knows them as.
  const cloud = parts.indexOf("com~apple~CloudDocs");
  if (cloud >= 0 && parts[cloud - 1] === "Mobile Documents") return cloud === parts.length - 1 ? "iCloud Drive" : parts.at(-1)!;
  const last = parts.at(-1) ?? path;
  if (parts.length > 1 && parts.at(-2) === "Mobile Documents") return last.replace(/^com~apple~/, "").replace(/^iCloud~/, "");
  return last.length < 3 && parts.length > 1 ? `${parts.at(-2)}/${last}` : last;
}

/** Same folder, ignoring trailing slashes and unicode composition (APFS stores names decomposed; the browser types them composed). */
export function samePath(a: string | undefined, b: string | undefined) {
  if (a === undefined || b === undefined) return false;
  const canonical = (value: string) => (value.length > 1 ? value.replace(/[\\/]+$/, "") : value).normalize("NFC");
  return canonical(a) === canonical(b);
}

/** The server words macOS privacy refusals as "macOS is blocking access to ...". */
export const isPrivacyMessage = (message: string | null | undefined) => Boolean(message && /^macOS (?:is blocking|blocked access|can only ask|didn't let)/.test(message));
