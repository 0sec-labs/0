import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "@0/engine/shared";

/** Registry under ~/.0: engines.json is canonical and the only file written; backends.json is read when engines.json does not exist. */
export function defaultEnginesConfigPath(): { read: string; write: string } {
  const write = join(homeStateDir(), "engines.json");
  const legacy = join(homeStateDir(), "backends.json");
  return { write, read: !existsSync(write) && existsSync(legacy) ? legacy : write };
}
