import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Emit only the command/web dependency graph. Retired renderer artifacts from an
// earlier checkout must not linger in a production package after an incremental build.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", fileURLToPath(new URL("../tsconfig.build.json", import.meta.url))], { stdio: "inherit" });
