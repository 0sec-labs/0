/**
 * Research packs: niche, offensive-research command implementations that are
 * loaded on first use rather than at CLI startup. Command definitions (name,
 * description, flags) stay eagerly registered so `--help` and the generated docs
 * list them; only the implementation behind `.action()` is a dynamic import.
 *
 * `ZERO_EDITION=core` (bundle define `__ZERO_EDITION__`, or the same env var at
 * runtime for tests) marks a build without these packs. A pack command then
 * prints a pointer to the full edition instead of failing on a missing module.
 */

declare const __ZERO_EDITION__: string | undefined;

export type ResearchPackName = "identity" | "adgraph" | "entragraph" | "xnu-fuzz";

export function isCoreEdition(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof __ZERO_EDITION__ !== "undefined" && __ZERO_EDITION__ === "core") return true;
  return env["ZERO_EDITION"] === "core";
}

export function researchPackUnavailableMessage(pack: ResearchPackName): string {
  return `This command is part of the full edition (research pack: ${pack}).`;
}

/** Import a pack's engine module, or print the core-edition notice and return undefined. */
export async function loadResearchPack<T>(pack: ResearchPackName, load: () => Promise<T>): Promise<T | undefined> {
  if (isCoreEdition()) {
    process.stderr.write(`${researchPackUnavailableMessage(pack)}\n`);
    process.exitCode = 2;
    return undefined;
  }
  return load();
}
