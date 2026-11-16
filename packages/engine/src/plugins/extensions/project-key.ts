import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The canonical key a project is stored under (symlinks resolved), so a project has one enablement entry. */
export const projectKeyOf = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
