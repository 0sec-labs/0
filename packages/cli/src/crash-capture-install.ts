// Side-effect module: imported right after apply-env-aliases so the handlers
// exist before the engine and command modules evaluate (a crash while loading
// them is captured too). `0 web` and no-argument launches are the web surface.
import { installCrashCapture } from "./crash-capture.js";

const first = process.argv[2];
installCrashCapture({ surface: first === undefined || first === "web" ? "web" : "cli" });
