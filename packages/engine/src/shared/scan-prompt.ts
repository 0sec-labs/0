/**
 * The message that turns a thread into a scan. `0 scan` and `/scan` in chat send the same text, so a
 * scan reads the same wherever it starts: load the scan skill, record findings with locations, summarise.
 */
export function scanPrompt(target: string, skill = "scan"): string {
  return [
    `Scan ${target} for exploitable security bugs. Load the \`${skill}\` skill with load_skill and follow it.`,
    "Record each confirmed issue with the finding tool, setting source_path, source_start_line and source_end_line, and suggested_replacement when you can give a concrete fix.",
    "Finish with a short summary of what you covered and what you did not.",
  ].join("\n");
}
