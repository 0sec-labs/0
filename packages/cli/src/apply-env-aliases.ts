// Side-effect module: imported first by the CLI entry so deprecated environment
// names are mapped onto their replacements before any other module reads env.
// The host console worker is spawned as `index.js --host-console-worker`, so it
// passes through the same entry.
import { applyEnvAliases } from "@0/engine";

applyEnvAliases();
