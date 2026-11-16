// Side-effect module: imported first by the CLI entry so deprecated environment
// names are mapped onto their replacements before any other module reads env.
// The host console worker is spawned as `index.js --host-console-worker`, so it
// passes through the same entry.
// A narrow subpath, not the engine barrel: this runs before `0 --version` and `0 --help`.
import { applyEnvAliases } from "@0/engine/config/deprecated-env";

applyEnvAliases();
