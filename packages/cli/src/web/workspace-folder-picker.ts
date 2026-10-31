import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const PICKER_SCRIPT = `on run argv
  activate
  try
    if (count of argv) > 0 then
      set chosen to choose folder with prompt "Choose the folder where Zero works" default location (POSIX file (item 1 of argv))
    else
      set chosen to choose folder with prompt "Choose the folder where Zero works"
    end if
    return POSIX path of chosen
  on error number -128
    return ""
  end try
end run`;

interface PickerDependencies {
  platform?: NodeJS.Platform;
  run?: (file: string, args: string[], options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<{ stdout: string }>;
}
let pickerActive = false;

/** Owner-authorized native UI only: choosing a folder does not grant session scope. */
export async function chooseWorkspaceFolder(input?: unknown, dependencies: PickerDependencies = {}): Promise<{ supported: boolean; path: string | null }> {
  if (input !== undefined && (typeof input !== "string" || input.length > 4096 || input.includes("\0"))) throw new Error("Enter a valid folder path.");
  if ((dependencies.platform ?? process.platform) !== "darwin") return { supported: false, path: null };
  if (pickerActive) throw new Error("A folder chooser is already open on this host.");
  pickerActive = true;
  try {
    const args = ["-e", PICKER_SCRIPT];
    if (typeof input === "string" && input.trim()) {
      const initial = await realpath(resolve(input));
      if (!(await stat(initial)).isDirectory()) throw new Error("Choose a folder rather than a file.");
      args.push(initial);
    }
    let stdout: string;
    try { ({ stdout } = await (dependencies.run ?? execute)("/usr/bin/osascript", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16_384, windowsHide: true })); }
    catch { throw new Error("The folder chooser could not complete on this host. Try again or enter a folder path."); }
    // osascript appends one record terminator; spaces/newlines in names are data.
    const selected = stdout.replace(/\r?\n$/, "");
    if (!selected) return { supported: true, path: null };
    if (selected.length > 4096 || selected.includes("\0")) throw new Error("The folder chooser returned an invalid path.");
    const path = await realpath(selected);
    if (!(await stat(path)).isDirectory()) throw new Error("The folder chooser did not return an existing folder.");
    return { supported: true, path };
  } finally { pickerActive = false; }
}
