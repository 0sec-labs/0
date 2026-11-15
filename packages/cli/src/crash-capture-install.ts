// Side-effect module: imported right after apply-env-aliases so the handlers
// exist before the engine and command modules evaluate (a crash while loading
// them is captured too). `0 web` and no-argument launches are the web surface.
import { installCrashCapture } from "./crash-capture.js";
import { surfaceFromArgv } from "./surface.js";

installCrashCapture({ surface: surfaceFromArgv(process.argv) });
